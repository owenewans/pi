// bridges ACP sessions to isolated instances of this fork's RPC mode.
import { isAbsolute, resolve } from "node:path";
import type {
	Agent,
	AgentSideConnection,
	AuthenticateRequest,
	CancelNotification,
	ContentBlock,
	InitializeResponse,
	ListSessionsRequest,
	LoadSessionRequest,
	NewSessionRequest,
	PromptRequest,
	PromptResponse,
	SessionConfigOption,
	SetSessionConfigOptionRequest,
	ToolKind,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getPackageDir, isBunBinary, VERSION } from "../../config.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { RpcClient } from "../rpc/rpc-client.ts";

type Session = { client: RpcClient; cwd: string; turn?: Turn; updates: Promise<void> };
type Turn = {
	resolve(aborted: boolean): void;
	reject(error: Error): void;
	settled: Promise<boolean>;
	cancelled: boolean;
	error?: string;
};

/** Serve ACP requests through one RPC child per editor session. */
export class AcpAgent implements Agent {
	private readonly sessions = new Map<string, Session>();
	private readonly clients = new Set<RpcClient>();
	private closed = false;
	constructor(
		connection: AgentSideConnection,
		createClient: (cwd: string, sessionId?: string) => RpcClient = createRpcClient,
	) {
		this.connection = connection;
		this.createClient = createClient;
	}
	private readonly connection: AgentSideConnection;
	private readonly createClient: (cwd: string, sessionId?: string) => RpcClient;

	async initialize(): Promise<InitializeResponse> {
		return {
			protocolVersion: 1,
			agentInfo: { name: "pi", version: VERSION },
			authMethods: [
				{
					id: "terminal",
					name: "Log in with pi",
					type: "terminal",
					args: ["acp", "--terminal-login"],
					_meta: {
						"terminal-auth": {
							command: isBunBinary ? process.execPath : resolve(getPackageDir(), "dist/bundle/cli.js"),
							args: ["acp", "--terminal-login"],
							label: "Open pi",
						},
					},
				},
			],
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: { list: {} },
				promptCapabilities: { image: true, embeddedContext: true },
				mcpCapabilities: {},
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<void> {
		if (params.methodId !== "terminal") throw RequestError.invalidParams("Unknown authentication method");
	}

	async newSession(params: NewSessionRequest) {
		return this.openSession(params);
	}

	async listSessions(params: ListSessionsRequest) {
		const cwd = params.cwd;
		if (!cwd || !isAbsolute(cwd)) throw RequestError.invalidParams("An absolute cwd is required");
		if (params.cursor) throw RequestError.invalidParams("Unknown cursor");
		const sessions = await SessionManager.list(cwd);
		return {
			sessions: sessions.map((session) => ({
				sessionId: session.id,
				cwd,
				title: session.name || session.firstMessage || undefined,
				updatedAt: session.modified.toISOString(),
			})),
		};
	}

	async loadSession(params: LoadSessionRequest) {
		const existing = this.sessions.get(params.sessionId);
		if (
			!isAbsolute(params.cwd) ||
			(existing ? existing.cwd !== params.cwd : !SessionManager.findById(params.cwd, params.sessionId))
		)
			throw RequestError.invalidParams("Unknown session");
		if (params.mcpServers.length)
			throw RequestError.invalidParams("ACP-provided MCP servers are not supported; configure them in pi");
		const opened = existing
			? { sessionId: params.sessionId, configOptions: await modelOptions(existing.client) }
			: await this.openSession(params, params.sessionId);
		const session = this.sessions.get(opened.sessionId)!;
		for (const message of await session.client.getMessages()) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const content =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			for (const part of content)
				if (part.type === "text")
					await this.connection.sessionUpdate({
						sessionId: opened.sessionId,
						update: {
							sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
							content: { type: "text", text: part.text },
						},
					});
		}
		return { configOptions: opened.configOptions };
	}

	private async openSession(params: NewSessionRequest, sessionId?: string) {
		if (!isAbsolute(params.cwd)) throw RequestError.invalidParams("cwd must be absolute");
		if (params.mcpServers.length)
			throw RequestError.invalidParams("ACP-provided MCP servers are not supported; configure them in pi");
		if (this.closed) throw RequestError.internalError(undefined, "ACP connection is closed");
		if (sessionId && this.sessions.has(sessionId))
			throw RequestError.invalidRequest(undefined, "Session is already open");
		const client = this.createClient(params.cwd, sessionId);
		this.clients.add(client);
		try {
			await client.start();
			if (this.closed) throw new Error("ACP connection is closed");
			const state = await client.getState();
			if (this.closed) throw new Error("ACP connection is closed");
			if (sessionId && state.sessionId !== sessionId) throw new Error("Pi opened a different session");
			const session: Session = { client, cwd: params.cwd, updates: Promise.resolve() };
			this.sessions.set(state.sessionId, session);
			client.onExit((error) => session.turn?.reject(error));
			client.onEvent((event) => {
				if (event.type === "agent_settled") {
					session.turn?.resolve(event.aborted);
					return;
				}
				if (
					event.type === "message_end" &&
					event.message.role === "assistant" &&
					event.message.stopReason === "error" &&
					session.turn
				)
					session.turn.error = event.message.errorMessage ?? "Model request failed";
				let update: Parameters<AgentSideConnection["sessionUpdate"]>[0]["update"] | undefined;
				if (event.type === "message_update") {
					const item = event.assistantMessageEvent;
					if (item.type === "text_delta" || item.type === "thinking_delta")
						update = {
							sessionUpdate: item.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
							content: { type: "text", text: item.delta },
						};
				} else if (event.type === "tool_execution_start") {
					const args = event.args;
					const path =
						args && typeof args === "object" && "path" in args && typeof args.path === "string"
							? resolve(session.cwd, args.path)
							: undefined;
					update = {
						sessionUpdate: "tool_call",
						toolCallId: event.toolCallId,
						title: event.toolName,
						kind: toolKind(event.toolName),
						status: "in_progress",
						rawInput: args,
						...(path ? { locations: [{ path }] } : {}),
					};
				} else if (event.type === "tool_execution_end") {
					const content = event.result.content.flatMap((part: unknown) =>
						part &&
						typeof part === "object" &&
						"type" in part &&
						part.type === "text" &&
						"text" in part &&
						typeof part.text === "string"
							? [{ type: "content" as const, content: { type: "text" as const, text: part.text } }]
							: [],
					);
					update = {
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: event.isError ? "failed" : "completed",
						content,
						rawOutput: event.result,
					};
				}
				if (update)
					session.updates = session.updates
						.then(() => this.connection.sessionUpdate({ sessionId: state.sessionId, update: update! }))
						.catch(() => {
							session.turn?.reject(new Error("ACP client disconnected"));
						});
			});
			return { sessionId: state.sessionId, configOptions: await modelOptions(client) };
		} catch (error) {
			this.clients.delete(client);
			await client.stop();
			if (client.getStderr().includes("No models available"))
				throw RequestError.authRequired(undefined, "Log in with pi in a terminal");
			throw RequestError.internalError(undefined, error instanceof Error ? error.message : "Failed to start pi");
		}
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw RequestError.invalidParams("Unknown session");
		if (session.turn) throw RequestError.invalidRequest("Session is already processing a prompt");
		const { message, images } = translatePrompt(params.prompt);
		let resolveTurn: (aborted: boolean) => void = () => {};
		let rejectTurn: (error: Error) => void = () => {};
		const settled = new Promise<boolean>((resolve, reject) => {
			resolveTurn = resolve;
			rejectTurn = reject;
		});
		// A child can exit before prompt acceptance; observe that rejection immediately.
		void settled.catch(() => {});
		const turn: Turn = { resolve: resolveTurn, reject: rejectTurn, settled, cancelled: false };
		session.turn = turn;
		try {
			const disposition = await session.client.prompt(message, images);
			const aborted = disposition === "handled" ? false : await turn.settled;
			await session.updates;
			if (turn.error) throw RequestError.internalError(undefined, turn.error);
			return { stopReason: aborted || turn.cancelled ? "cancelled" : "end_turn" };
		} catch (error) {
			if (error instanceof Error && error.message.includes("No API key found for the selected model"))
				throw RequestError.authRequired(undefined, "Log in with pi in a terminal");
			throw error;
		} finally {
			session.turn = undefined;
		}
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest) {
		const session = this.sessions.get(params.sessionId);
		if (!session || params.configId !== "model" || typeof params.value !== "string")
			throw RequestError.invalidParams("Unknown session or configuration option");
		if (session.turn) throw RequestError.invalidRequest(undefined, "Cannot change model during a turn");
		const available = await session.client.getAvailableModels();
		const selected = available.find((model) => modelValue(model.provider, model.id) === params.value);
		if (!selected) throw RequestError.invalidParams("Unknown model");
		await session.client.setModel(selected.provider, selected.id);
		return { configOptions: await modelOptions(session.client) };
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session?.turn) return;
		session.turn.cancelled = true;
		await session.client.abort();
	}

	/** Close all child sessions when the ACP client disconnects. */
	async close(): Promise<void> {
		this.closed = true;
		this.sessions.clear();
		const clients = [...this.clients];
		this.clients.clear();
		await Promise.allSettled(clients.map((client) => client.stop()));
	}
}

function createRpcClient(cwd: string, sessionId?: string): RpcClient {
	return new RpcClient({
		cwd,
		command: process.execPath,
		cliPath: isBunBinary ? false : resolve(getPackageDir(), "dist/bundle/cli.js"),
		args: ["--no-themes", ...(sessionId ? ["--session-id", sessionId] : [])],
	});
}

function modelValue(provider: string, id: string): string {
	return JSON.stringify([provider, id]);
}

async function modelOptions(client: RpcClient): Promise<SessionConfigOption[]> {
	const [state, models] = await Promise.all([client.getState(), client.getAvailableModels()]);
	if (!state.model || !models.length) return [];
	return [
		{
			type: "select",
			id: "model",
			name: "Model",
			category: "model",
			currentValue: modelValue(state.model.provider, state.model.id),
			options: models.map((model) => ({
				value: modelValue(model.provider, model.id),
				name: `${model.provider}/${model.id}`,
			})),
		},
	];
}

function toolKind(name: string): ToolKind {
	if (name === "read") return "read";
	if (name === "edit" || name === "write" || name === "hashline_edit") return "edit";
	if (name === "bash" || name === "process") return "execute";
	if (name.includes("search") || name === "grep" || name === "find") return "search";
	return "other";
}

function translatePrompt(blocks: ContentBlock[]): { message: string; images: ImageContent[] } {
	const parts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "image") images.push({ type: "image", data: block.data, mimeType: block.mimeType });
		else if (block.type === "resource_link") parts.push(`[Context] ${block.uri}`);
		else if (block.type === "resource")
			parts.push(
				`[Embedded context] ${block.resource.uri}\n${"text" in block.resource ? block.resource.text : "Binary resource"}`,
			);
		else parts.push(`[Audio] ${block.mimeType} is not supported`);
	}
	return { message: parts.join("\n"), images };
}
