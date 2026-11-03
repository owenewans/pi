import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import codeExtension from "../src/extensions/code/index.ts";
import codemodeExtension from "../src/extensions/codemode/index.ts";
import subagentsExtension from "../src/extensions/subagents/index.ts";
import workflowExtension from "../src/extensions/workflow/index.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

type JobInfo = {
	id: string;
	role: "scout" | "reviewer" | "worker";
	task: string;
	status: "running" | "completed" | "failed" | "stopped";
	output?: string;
};

let directory: string;
const runners: ExtensionRunner[] = [];
const sessions: AgentSession[] = [];
const releases: (() => void)[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-subagents-extension-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const runner of runners.splice(0)) await runner.emit({ type: "session_shutdown", reason: "quit" });
	for (const session of sessions.splice(0)) session.dispose();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function blockedResponse(text = "finished") {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 3000);
		release = () => {
			clearTimeout(timer);
			resolve();
		};
	});
	releases.push(release);
	let signal: AbortSignal | undefined;
	const response: FauxResponseFactory = async (_context, options) => {
		signal = options?.signal;
		await ready;
		return fauxAssistantMessage(text);
	};
	return {
		response,
		ready,
		release,
		get signal() {
			return signal;
		},
	};
}

async function setup(
	responses: FauxResponseStep[] = [],
	factories: ExtensionFactory[] = [],
	options: { additionalExtensionPaths?: string[]; excludeTools?: string[] } = {},
) {
	const sendMessage = vi.fn();
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const faux = fauxProvider();
	faux.setResponses(responses);
	registry.registerProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt: "parent system prompt",
		extensionFactories: [subagentsExtension, ...factories],
		additionalExtensionPaths: options.additionalExtensionPaths,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		modelRuntime: getModelRuntime(registry),
		model: faux.getModel(),
		thinkingLevel: "off",
		excludeTools: options.excludeTools,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(directory),
	});
	sessions.push(session);
	await session.bindExtensions({});
	const runtime = loader.getExtensions().runtime;
	runtime.sendMessage = sendMessage;
	const runner = session.extensionRunner;
	const extension = loader.getExtensions().extensions.find((extension) => extension.tools.has("subagent"));
	if (!extension) throw new Error("subagents extension not loaded");
	runners.push(runner);
	const registered = extension.tools.get("subagent");
	if (!registered) throw new Error("subagent tool not registered");
	const tool = registered.definition;
	const context = runner.createToolContext("fixture", undefined);
	Object.defineProperty(context, "model", {
		value: faux.getModel(),
		configurable: true,
	});
	context.getSystemPrompt = () => "parent system prompt";
	async function execute(params: Parameters<typeof tool.execute>[1], signal?: AbortSignal) {
		const result = await tool.execute("fixture", params, signal, undefined, context);
		const { results } = result.details as { results: JobInfo[] };
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: JSON.stringify(results),
		});
		return results;
	}
	return {
		session,
		loader,
		runner,
		tool,
		context,
		registry,
		faux,
		sendMessage,
		execute,
	};
}

async function settle(runner: ExtensionRunner, outcome: "completed" | "aborted" | "error" = "completed") {
	return runner.emitBoundary({ type: "agent_before_settle", outcome }, () => ({
		contextEntries: [],
		contextMessages: [],
		llmMessages: [],
		pendingMessages: [],
		canContinue: false,
	}));
}

const task = (role: "scout" | "reviewer" | "worker" = "scout", text = "investigate fixture") => ({ role, task: text });

describe("subagent tool", () => {
	it.each(["completed", "failed"] as const)("releases child provider resources after a %s task", async (status) => {
		const fixture = await setup([
			fauxAssistantMessage("fixture result", { stopReason: status === "failed" ? "error" : "stop" }),
		]);
		const stream = vi.spyOn(getModelRuntime(fixture.registry), "streamSimple");
		const cleanup = vi.fn();
		const unregister = registerSessionResourceCleanup(cleanup);
		try {
			const [job] = await fixture.execute({ tasks: [task()] });
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			const childId = stream.mock.calls[0][2]?.sessionId;
			expect(childId).toEqual(expect.any(String));
			expect(cleanup).toHaveBeenCalledExactlyOnceWith(childId);
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([{ status }]);
		} finally {
			unregister();
		}
	});

	it.each(["stop", "tree", "shutdown"] as const)(
		"waits for a child to finish before cleanup on %s",
		async (action) => {
			const blocked = blockedResponse();
			const fixture = await setup([blocked.response]);
			const stream = vi.spyOn(getModelRuntime(fixture.registry), "streamSimple");
			const cleanup = vi.fn();
			const unregister = registerSessionResourceCleanup(cleanup);
			try {
				const [job] = await fixture.execute({ tasks: [task()] });
				await vi.waitFor(() => expect(blocked.signal).toBeDefined());
				const stopping =
					action === "stop"
						? fixture.execute({ action: "stop", id: job.id })
						: action === "tree"
							? fixture.runner.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "new" })
							: fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
				await vi.waitFor(() => expect(blocked.signal?.aborted).toBe(true));
				expect(cleanup).not.toHaveBeenCalled();
				blocked.release();
				await stopping;
				const childId = stream.mock.calls[0][2]?.sessionId;
				expect(childId).toEqual(expect.any(String));
				expect(cleanup).toHaveBeenCalledExactlyOnceWith(childId);
				expect(fixture.sendMessage).not.toHaveBeenCalled();
			} finally {
				unregister();
			}
		},
	);

	it("reports provider resource cleanup failures", async () => {
		const fixture = await setup([fauxAssistantMessage("fixture result")]);
		const unregister = registerSessionResourceCleanup(() => {
			throw new Error("fixture cleanup failure");
		});
		try {
			const [job] = await fixture.execute({ tasks: [task()] });
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
				{ status: "failed", output: expect.stringContaining("cleanup session resources") },
			]);
		} finally {
			unregister();
		}
	});

	it("uses optional tasks so management actions need no dummy tasks", async () => {
		const fixture = await setup();
		expect(fixture.tool.parameters).toMatchObject({
			type: "object",
			properties: { tasks: { minItems: 1, maxItems: 4 } },
		});
		expect((fixture.tool.parameters as { required?: string[] }).required ?? []).not.toContain("tasks");
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		expect(await fixture.execute({ action: "clear" })).toEqual([]);
	});

	it("returns IDs before completion, allows parent work and survives parent abort", async () => {
		const blocked = blockedResponse();
		const fixture = await setup([blocked.response, fauxAssistantMessage("parent worked")]);
		const parentController = new AbortController();
		const [job] = await fixture.execute({ tasks: [task()] }, parentController.signal);
		expect(job).toMatchObject({
			id: expect.any(String),
			status: "running",
			role: "scout",
		});
		await vi.waitFor(() => expect(blocked.signal).toBeDefined());
		parentController.abort();
		expect(blocked.signal?.aborted).toBe(false);
		const parent = new Agent({
			initialState: {
				model: fixture.faux.getModel(),
				systemPrompt: "parent",
				tools: [],
			},
			streamFn: (model, context, options) => fixture.registry.streamSimple(model, context, options),
		});
		await parent.prompt("do independent work");
		expect(parent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "parent worked" }],
		});
		expect(await fixture.execute({ action: "result", id: job.id })).toEqual([job]);
		expect(fixture.sendMessage).not.toHaveBeenCalled();
		blocked.release();
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		const [result] = await fixture.execute({ action: "result", id: job.id });
		expect(result).toEqual({ ...job, status: "completed", output: "finished" });
		expect(fixture.sendMessage).toHaveBeenCalledWith(
			{
				customType: "subagent-result",
				content: JSON.stringify(result),
				display: true,
				details: result,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(await fixture.execute({ action: "list" })).toEqual([{ ...job, status: "completed" }]);
		expect(await fixture.execute({ action: "clear" })).toEqual([]);
		await expect(fixture.execute({ action: "result", id: job.id })).rejects.toThrow("Unknown subagent");
	});

	it("keeps a child running when the native parent session is interrupted", async () => {
		const child = blockedResponse("child completed after interrupt");
		const parent = blockedResponse("parent interrupted");
		const fixture = await setup([child.response, parent.response]);
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(child.signal).toBeDefined());
		const parentRun = fixture.session.prompt("independent parent work");
		await vi.waitFor(() => expect(parent.signal).toBeDefined());
		const interruption = fixture.session.abort();
		await vi.waitFor(() => expect(parent.signal?.aborted).toBe(true));
		expect(child.signal?.aborted).toBe(false);
		parent.release();
		await Promise.all([parentRun, interruption]);
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([{ status: "running" }]);
		child.release();
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "child completed after interrupt" },
		]);
	});

	it("persists busy completions and requests one hidden continuation at normal settlement", async () => {
		const blocked = [blockedResponse("first"), blockedResponse("second")];
		const fixture = await setup(blocked.map((item) => item.response));
		fixture.context.isIdle = () => false;
		const jobs = await fixture.execute({ tasks: [task(), task("worker")] });
		for (const item of blocked) item.release();
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(2));
		for (const [index, job] of jobs.entries()) {
			const result = {
				...job,
				status: "completed",
				output: index === 0 ? "first" : "second",
			};
			expect(fixture.sendMessage).toHaveBeenCalledWith(
				{
					customType: "subagent-result",
					content: JSON.stringify(result),
					display: true,
					details: result,
				},
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		}
		expect(await settle(fixture.runner)).toMatchObject({
			continue: true,
			entries: [
				{
					type: "custom_message",
					customType: "subagent-continue",
					display: false,
					content: "Review the completed subagent results and continue the authorized task.",
				},
			],
		});
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
		expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
	});

	it.each(["aborted", "error"] as const)("does not wake a parent settling with %s", async (outcome) => {
		const fixture = await setup([fauxAssistantMessage("finished")]);
		fixture.context.isIdle = () => false;
		await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await settle(fixture.runner, outcome)).toMatchObject({
			continue: false,
			entries: [],
		});
		await fixture.runner.emit({
			type: "agent_settled",
			aborted: outcome === "aborted",
		});
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
	});

	it("clears a pending wake when the parent settles after an explicit interrupt", async () => {
		const fixture = await setup([fauxAssistantMessage("finished")]);
		fixture.context.isIdle = () => false;
		await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		await fixture.runner.emit({ type: "agent_settled", aborted: true });
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
	});

	it("wakes on results arriving between the last boundary and normal settlement", async () => {
		const fixture = await setup([fauxAssistantMessage("late result")]);
		fixture.context.isIdle = () => false;
		await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		await fixture.runner.emit({ type: "agent_settled", aborted: false });
		expect(fixture.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ customType: "subagent-continue", display: false }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await fixture.runner.emit({ type: "agent_settled", aborted: false });
		expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("clears completed jobs and their pending continuation on branch navigation", async () => {
		const fixture = await setup([fauxAssistantMessage("old result")]);
		fixture.context.isIdle = () => false;
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		await fixture.runner.emit({
			type: "session_tree",
			oldLeafId: "old",
			newLeafId: "new",
		});
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		await expect(fixture.execute({ action: "result", id: job.id })).rejects.toThrow("Unknown subagent");
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
		expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("cancels all old jobs on branch navigation and allows a fresh generation", async () => {
		const blocked = [blockedResponse("old scout"), blockedResponse("old worker")];
		const fixture = await setup([...blocked.map((item) => item.response), fauxAssistantMessage("new branch")]);
		const jobs = await fixture.execute({ tasks: [task(), task("worker")] });
		await vi.waitFor(() => expect(blocked.every((item) => item.signal !== undefined)).toBe(true));
		let settled = false;
		const navigation = fixture.runner.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "new" }).then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(blocked.every((item) => item.signal?.aborted)).toBe(true));
		expect(settled).toBe(false);
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		for (const job of jobs) {
			await expect(fixture.execute({ action: "result", id: job.id })).rejects.toThrow("Unknown subagent");
		}
		blocked[0].release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		blocked[1].release();
		await navigation;
		expect(fixture.sendMessage).not.toHaveBeenCalled();
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
		const [fresh] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "list" })).toEqual([{ ...fresh, status: "completed" }]);
		expect(await fixture.execute({ action: "result", id: fresh.id })).toMatchObject([{ output: "new branch" }]);
	});

	it.each(["scout", "reviewer", "worker"] as const)(
		"gives %s its role tools and isolated task context",
		async (role) => {
			const fixture = await setup([
				(context) => {
					const system = context.messages.find((message) => message.role === "system");
					expect(JSON.stringify(system)).toContain("parent system prompt");
					expect(JSON.stringify(system)).toContain("Do not delegate");
					expect(JSON.stringify(system)).toContain(
						role === "worker"
							? "Implement the assigned task"
							: role === "scout"
								? "Investigate the assigned task"
								: "Review the assigned change",
					);
					expect(system?.toolsAdded?.map((tool) => tool.name).sort()).toEqual(
						role === "worker" ? ["bash", "edit", "read", "write"] : ["find", "grep", "ls", "read"],
					);
					expect(context.messages.filter((message) => message.role !== "system")).toMatchObject([
						{
							role: "user",
							content: [{ type: "text", text: "self-contained task" }],
						},
					]);
					return fauxAssistantMessage("role checked");
				},
			]);
			const [job] = await fixture.execute({
				tasks: [task(role, "self-contained task")],
			});
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
				{ status: "completed", output: "role checked" },
			]);
		},
	);

	it("keeps native worker write and edit results without extra diagnostics", async () => {
		const path = join(directory, "fixture.c");
		const fixture = await setup([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "int before;\n" }), { stopReason: "toolUse" }),
			(context) => {
				expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
					toolName: "write",
					isError: false,
					content: [{ type: "text", text: `Successfully wrote to ${path}` }],
				});
				return fauxAssistantMessage(
					fauxToolCall("edit", {
						path,
						edits: [{ oldText: "before", newText: "after" }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
					toolName: "edit",
					isError: false,
					content: [
						{
							type: "text",
							text: `Successfully replaced 1 block(s) in ${path}.`,
						},
					],
				});
				return fauxAssistantMessage("worker finished");
			},
		]);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "worker finished" },
		]);
		expect(readFileSync(path, "utf8")).toBe("int after;\n");
	});

	it("executes an approved CLI tool with inherited effective flags without importing changed source", async () => {
		const path = join(directory, "cli-extension.mjs");
		writeFileSync(
			path,
			`export default function(pi) {
			pi.registerFlag("cli-fixture", { type: "string", default: "default" });
			pi.registerTool({
				name: "cli_fixture", label: "CLI fixture", description: "CLI fixture",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: pi.getFlag("cli-fixture") }], details: {} }; }
			});
		}`,
		);
		const fixture = await setup(
			[
				fauxAssistantMessage(fauxToolCall("cli_fixture", {}), { stopReason: "toolUse" }),
				(context) => {
					expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
						toolName: "cli_fixture",
						isError: false,
						content: [{ type: "text", text: "effective CLI value" }],
					});
					return fauxAssistantMessage("CLI extension inherited");
				},
			],
			[],
			{ additionalExtensionPaths: [path] },
		);
		fixture.loader.getExtensions().runtime.flagValues.set("cli-fixture", "effective CLI value");
		writeFileSync(path, 'throw new Error("fresh import forbidden")');
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "CLI extension inherited" },
		]);
	});

	it("keeps parent tool exclusions when a worker startup hook tries to reactivate tools", async () => {
		const fixture = await setup(
			[
				(context) => {
					expect(
						context.messages.find((message) => message.role === "system")?.toolsAdded?.map((tool) => tool.name),
					).toEqual(["read"]);
					return fauxAssistantMessage("exclusions retained");
				},
			],
			[
				(pi) => {
					pi.on("session_start", () => {
						pi.setActiveTools(["read", "write", "bash", "subagent"]);
					});
				},
			],
			{ excludeTools: ["write", "bash"] },
		);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "exclusions retained" },
		]);
	});

	it("runs child extension tools and exposes formatter diagnostics to the next model request", async () => {
		const path = join(directory, "formatted.txt");
		const fixture = await setup(
			[
				fauxAssistantMessage(fauxToolCall("write", { path, content: "before\n" }), { stopReason: "toolUse" }),
				(context) => {
					expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
						toolName: "write",
						content: [
							{
								type: "text",
								text: expect.stringContaining("formatter diagnostic"),
							},
						],
					});
					return fauxAssistantMessage(fauxToolCall("hashline_read", { path }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					expect(JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"))).toContain(
						"formatted",
					);
					return fauxAssistantMessage("checked formatted result");
				},
			],
			[
				codeExtension,
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName !== "write") return;
						writeFileSync(path, "formatted\n");
						return {
							content: [{ type: "text", text: "formatter diagnostic: formatted file" }],
						};
					});
				},
			],
		);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "checked formatted result" },
		]);
		expect(readFileSync(path, "utf8")).toBe("formatted\n");
	});

	it("isolates extension state, settings, session entries, event buses and lifecycle", async () => {
		const starts: string[] = [];
		const stops: string[] = [];
		const events: string[] = [];
		const counts: number[] = [];
		const fixture = await setup(
			[
				fauxAssistantMessage(fauxToolCall("counter", {}), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("first child"),
				fauxAssistantMessage(fauxToolCall("counter", {}), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("second child"),
			],
			[
				(pi) => {
					let count = 0;
					let id = "";
					pi.events.on("child-test", () => {
						events.push(id);
					});
					pi.on("session_start", (_event, ctx) => {
						id = ctx.sessionManager.getSessionId();
						starts.push(id);
						pi.appendEntry("child-test", { id });
					});
					pi.on("session_shutdown", () => {
						stops.push(id);
					});
					pi.registerTool({
						name: "counter",
						label: "counter",
						description: "counter",
						parameters: Type.Object({}),
						async execute() {
							pi.events.emit("child-test", {});
							count++;
							counts.push(count);
							return {
								content: [{ type: "text", text: String(count) }],
								details: {},
							};
						},
					});
				},
			],
		);
		for (let index = 1; index <= 2; index++) {
			await fixture.execute({ tasks: [task("worker")] });
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(index));
		}
		expect(new Set(starts).size).toBe(3);
		expect(stops).toEqual(starts.slice(1));
		expect(events).toEqual(starts.slice(1));
		expect(counts).toEqual([1, 1]);
		expect(
			fixture.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "child-test"),
		).toHaveLength(1);
	});

	it.each(["scout", "reviewer"] as const)(
		"keeps %s read-only after startup reactivation and denies nested/codemode calls",
		async (role) => {
			const path = join(directory, "must-not-exist");
			const fixture = await setup(
				[
					(context) => {
						const system = context.messages.find((message) => message.role === "system");
						expect(system?.toolsAdded?.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
						return fauxAssistantMessage(fauxToolCall("write", { path, content: "denied" }), {
							stopReason: "toolUse",
						});
					},
					(context) => {
						expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
							isError: true,
						});
						return fauxAssistantMessage("read only");
					},
				],
				[
					codemodeExtension,
					(pi) => {
						pi.on("session_start", async (_event, ctx) => {
							pi.setActiveTools(["read", "grep", "find", "ls", "write", "bash", "edit", "subagent", "codemode"]);
							if (!ctx.getSystemPrompt().includes("You are a subagent")) return;
							await expect(ctx.createChildSession({ instructions: "recursive" })).rejects.toThrow(
								"cannot create child",
							);
						});
					},
				],
			);
			const [job] = await fixture.execute({ tasks: [task(role)] });
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([{ status: "completed" }]);
			expect(existsSync(path)).toBe(false);
		},
	);

	it("denies delegation through a worker's nested tool API", async () => {
		const fixture = await setup(
			[
				fauxAssistantMessage(fauxToolCall("nested", {}), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("no delegation"),
			],
			[
				(pi) => {
					pi.registerTool({
						name: "nested",
						label: "nested",
						description: "nested",
						parameters: Type.Object({}),
						async execute(_id, _args, _signal, _update, ctx) {
							const result = await ctx.executeTool("subagent", {
								tasks: [task()],
							});
							expect(result.isError).toBe(true);
							await expect(ctx.createChildSession({ instructions: "recursive" })).rejects.toThrow(
								"cannot create child",
							);
							return {
								content: [{ type: "text", text: "denied" }],
								details: {},
							};
						},
					});
				},
			],
		);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "no delegation" },
		]);
		expect(fixture.faux.state.callCount).toBe(2);
	});

	it.each(["scout", "reviewer"] as const)(
		"denies nested write, codemode and MCP after %s tool reactivation",
		async (role) => {
			const outcomes: boolean[] = [];
			const fixture = await setup(
				[
					fauxAssistantMessage(fauxToolCall("read", {}), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("nested calls denied"),
				],
				[
					codemodeExtension,
					(pi) => {
						pi.on("session_start", () => {
							pi.setActiveTools(["read", "write", "codemode", "mcp__fixture__write"]);
						});
						pi.registerTool({
							name: "read",
							label: "read",
							description: "read fixture",
							parameters: Type.Object({}),
							async execute(_id, _args, _signal, _update, ctx) {
								for (const name of ["write", "codemode", "mcp__fixture__write", "subagent"]) {
									const result = await ctx.executeTool(name, {});
									outcomes.push(result.isError);
								}
								return {
									content: [{ type: "text", text: "checked" }],
									details: {},
								};
							},
						});
						pi.registerTool({
							name: "mcp__fixture__write",
							label: "forbidden",
							description: "forbidden",
							parameters: Type.Object({}),
							async execute() {
								outcomes.push(false);
								return { content: [], details: {} };
							},
						});
					},
				],
			);
			const [job] = await fixture.execute({ tasks: [task(role)] });
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([{ status: "completed" }]);
			expect(outcomes).toEqual([true, true, true, true]);
		},
	);

	it("keeps the parent's model, trust and credentials without replaying provider registrations", async () => {
		let parentId = "";
		const observed: boolean[] = [];
		const fixture = await setup(
			[fauxAssistantMessage("same runtime")],
			[
				(pi) => {
					pi.registerProvider("unused-child-provider", {
						baseUrl: "https://example.invalid",
						apiKey: "unused",
						api: "openai-completions",
						models: [],
					});
					pi.on("session_start", async (_event, ctx) => {
						if (!parentId) {
							parentId = ctx.sessionManager.getSessionId();
							return;
						}
						observed.push(ctx.isProjectTrusted());
						observed.push(await pi.setModel({ ...ctx.model!, id: "forbidden-switch" }));
						pi.unregisterProvider(ctx.model!.provider);
					});
				},
			],
		);
		fixture.session.settingsManager.setProjectTrusted(false);
		const runtime = getModelRuntime(fixture.registry);
		const register = vi.spyOn(runtime, "registerProvider");
		const unregister = vi.spyOn(runtime, "unregisterProvider");
		const stream = vi.spyOn(runtime, "streamSimple");
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "same runtime" },
		]);
		expect(observed).toEqual([false, false]);
		expect(register).not.toHaveBeenCalled();
		expect(unregister).not.toHaveBeenCalled();
		expect(stream.mock.calls[0][0]).toEqual(fixture.session.model);
	});

	it("blocks direct registry mutations from child hooks without changing the parent runtime", async () => {
		let parent = "";
		const fixture = await setup(
			[fauxAssistantMessage("parent registry intact")],
			[
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						if (!parent) {
							parent = ctx.sessionManager.getSessionId();
							return;
						}
						expect(() => ctx.modelRegistry.unregisterProvider(ctx.model!.provider)).toThrow(
							"cannot change the model registry",
						);
						expect(() => ctx.modelRegistry.unregisterVirtualModel("router", "auto")).toThrow(
							"cannot change the model registry",
						);
					});
				},
			],
		);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "parent registry intact" },
		]);
		expect(fixture.registry.find(fixture.session.model!.provider, fixture.session.model!.id)).toBeDefined();
	});

	it("honors a child startup shutdown without sending a model request", async () => {
		let loads = 0;
		const shutdown = vi.fn();
		const fixture = await setup(
			[],
			[
				(pi) => {
					const child = loads++ > 0;
					pi.on("session_start", (_event, ctx) => {
						if (child) ctx.shutdown();
					});
					pi.on("session_shutdown", shutdown);
				},
			],
		);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "failed", output: expect.stringContaining("shut down during startup") },
		]);
		expect(fixture.faux.state.callCount).toBe(0);
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("routes a shared virtual model through the child's extension context and clears its router on disposal", async () => {
		let loads = 0;
		let physical: NonNullable<ReturnType<ReturnType<typeof fauxProvider>["getModel"]>>;
		const routes: Array<{ instance: number; sessionId: string }> = [];
		const fixture = await setup(
			[fauxAssistantMessage("child routed"), fauxAssistantMessage("parent routed")],
			[
				(pi) => {
					const instance = loads++;
					pi.registerVirtualModel({
						provider: "fixture-router",
						id: "auto",
						name: "Auto",
						route: (_request, ctx) => {
							routes.push({ instance, sessionId: ctx.sessionManager.getSessionId() });
							return { model: physical, thinkingLevel: "off" };
						},
					});
				},
			],
		);
		physical = fixture.faux.getModel();
		const runtime = getModelRuntime(fixture.registry);
		await runtime.refresh({ allowNetwork: false });
		const model = runtime.getModel("fixture-router", "auto");
		if (!model) throw new Error("virtual fixture not registered");
		await fixture.session.setModel(model);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "child routed" },
		]);
		expect(routes).toHaveLength(1);
		expect(routes[0].instance).toBe(1);
		expect(routes[0].sessionId).not.toBe(fixture.session.sessionId);
		await runtime.resolveModel(model, [], { sessionId: routes[0].sessionId, reason: "direct", thinkingLevel: "off" });
		expect(routes[1]).toEqual({ instance: 0, sessionId: fixture.session.sessionId });
		await fixture.session.prompt("parent work after child cleanup");
		expect(routes[2]).toEqual({ instance: 0, sessionId: fixture.session.sessionId });
	});

	it("does not inherit an active parent goal or its continuation loop", async () => {
		const fixture = await setup(
			[
				(context) => {
					expect(JSON.stringify(context.messages)).not.toContain("parent continuous goal");
					return fauxAssistantMessage("child finished once");
				},
			],
			[workflowExtension],
		);
		fixture.session.sessionManager.appendCustomEntry("goal", {
			task: "parent continuous goal",
			active: true,
		});
		await fixture.runner.emit({
			type: "session_tree",
			oldLeafId: "old",
			newLeafId: "new",
		});
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{ status: "completed", output: "child finished once" },
		]);
		expect(fixture.faux.state.callCount).toBe(1);
	});

	it("shuts down a child stopped during asynchronous session startup without making a model request", async () => {
		const blocked = blockedResponse();
		let starting = false;
		const shutdown = vi.fn();
		const fixture = await setup(
			[],
			[
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						if (!ctx.getSystemPrompt().includes("You are a subagent")) return;
						starting = true;
						await blocked.ready;
					});
					pi.on("session_shutdown", shutdown);
				},
			],
		);
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(starting).toBe(true));
		const stop = fixture.execute({ action: "stop", id: job.id });
		blocked.release();
		expect(await stop).toMatchObject([{ status: "stopped" }]);
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(fixture.faux.state.callCount).toBe(0);
		expect(fixture.sendMessage).not.toHaveBeenCalled();
	});

	it("reports shutdown hook failures and still releases child provider resources", async () => {
		const fixture = await setup(
			[fauxAssistantMessage("done")],
			[
				(pi) => {
					pi.on("session_shutdown", () => {
						throw new Error("child shutdown failed");
					});
				},
			],
		);
		const cleanup = vi.fn();
		const unregister = registerSessionResourceCleanup(cleanup);
		try {
			const [job] = await fixture.execute({ tasks: [task()] });
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
				{
					status: "failed",
					output: expect.stringContaining("child shutdown failed"),
				},
			]);
			expect(cleanup).toHaveBeenCalledTimes(1);
		} finally {
			unregister();
		}
	});

	it("shuts down initialized factories if native child construction fails", async () => {
		let loads = 0;
		const shutdown = vi.fn();
		const fixture = await setup(
			[],
			[
				(pi) => {
					const child = loads++ > 0;
					pi.on("session_shutdown", shutdown);
					pi.registerTool({
						name: "broken-child",
						label: "broken",
						description: "broken",
						parameters: Type.Object({}),
						get promptSnippet() {
							if (child) throw new Error("child construction failed");
							return "fixture";
						},
						async execute() {
							return { content: [], details: {} };
						},
					});
				},
			],
		);
		const cleanup = vi.fn();
		const unregister = registerSessionResourceCleanup(cleanup);
		try {
			const [job] = await fixture.execute({ tasks: [task("worker")] });
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
				{
					status: "failed",
					output: expect.stringContaining("child construction failed"),
				},
			]);
			expect(shutdown).toHaveBeenCalledTimes(1);
			expect(cleanup).toHaveBeenCalledTimes(1);
		} finally {
			unregister();
		}
	});

	it("emits shutdown for initialized child extensions when another child factory fails", async () => {
		let loads = 0;
		const shutdown = vi.fn();
		const fixture = await setup(
			[],
			[
				(pi) => {
					pi.on("session_shutdown", shutdown);
				},
				() => {
					if (loads++ > 0) throw new Error("child startup failed");
				},
			],
		);
		const [job] = await fixture.execute({ tasks: [task("worker")] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
			{
				status: "failed",
				output: expect.stringContaining("child startup failed"),
			},
		]);
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(fixture.faux.state.callCount).toBe(0);
	});

	it("enforces four active jobs across calls and clears only finished jobs", async () => {
		const blocked = Array.from({ length: 5 }, () => blockedResponse());
		const fixture = await setup(blocked.map((item) => item.response));
		const first = await fixture.execute({ tasks: [task(), task("reviewer")] });
		const second = await fixture.execute({
			action: "start",
			tasks: [task("worker"), task()],
		});
		expect(new Set([...first, ...second].map((job) => job.id)).size).toBe(4);
		await expect(fixture.execute({ tasks: [task()] })).rejects.toThrow("At most four");
		expect(await fixture.execute({ action: "clear" })).toHaveLength(4);
		blocked[0].release();
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "clear" })).toHaveLength(3);
		expect(await fixture.execute({ tasks: [task()] })).toHaveLength(1);
		expect(await fixture.execute({ action: "list" })).toHaveLength(4);
	});

	it("stops a job, waits for it and never delivers a stopped notification", async () => {
		const blocked = blockedResponse();
		const fixture = await setup([blocked.response]);
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(blocked.signal).toBeDefined());
		let settled = false;
		const stopping = fixture.execute({ action: "stop", id: job.id }).then((result) => {
			settled = true;
			return result;
		});
		await vi.waitFor(() => expect(blocked.signal?.aborted).toBe(true));
		expect(settled).toBe(false);
		blocked.release();
		expect(await stopping).toMatchObject([{ id: job.id, status: "stopped" }]);
		expect(await fixture.execute({ action: "stop", id: job.id })).toMatchObject([{ status: "stopped" }]);
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([{ status: "stopped" }]);
		expect(fixture.sendMessage).not.toHaveBeenCalled();
	});

	it("delivers thrown provider failures as failed results and wakes the parent", async () => {
		const fixture = await setup([
			() => {
				throw new Error("offline provider exploded");
			},
		]);
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		const [result] = await fixture.execute({ action: "result", id: job.id });
		expect(result).toMatchObject({
			status: "failed",
			output: expect.stringContaining("offline provider exploded"),
		});
		expect(fixture.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-result",
				details: result,
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it("aborts all jobs on shutdown and waits without delivering results", async () => {
		const blocked = [blockedResponse(), blockedResponse()];
		const fixture = await setup(blocked.map((item) => item.response));
		await fixture.execute({ tasks: [task(), task("worker")] });
		await vi.waitFor(() => expect(blocked.every((item) => item.signal !== undefined)).toBe(true));
		let settled = false;
		const shutdown = fixture.runner.emit({ type: "session_shutdown", reason: "quit" }).then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(blocked.every((item) => item.signal?.aborted)).toBe(true));
		expect(settled).toBe(false);
		blocked[0].release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		blocked[1].release();
		await shutdown;
		expect(fixture.sendMessage).not.toHaveBeenCalled();
		await expect(fixture.execute({ tasks: [task()] })).rejects.toThrow("shut down");
	});

	it("rejects an already aborted start without creating a job", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		controller.abort(new Error("parent interrupted"));
		await expect(fixture.execute({ tasks: [task()] }, controller.signal)).rejects.toThrow("parent interrupted");
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		expect(fixture.faux.state.callCount).toBe(0);
	});

	it("requires a model only for starting jobs", async () => {
		const fixture = await setup();
		Object.defineProperty(fixture.context, "model", { value: undefined });
		await expect(fixture.execute({ tasks: [task()] })).rejects.toThrow("No model selected");
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		expect(await fixture.execute({ action: "clear" })).toEqual([]);
	});

	it.each([
		[{}, "start requires tasks"],
		[{ action: "start", tasks: [] }, "start requires tasks"],
		[{ action: "result" }, "result requires id"],
		[{ action: "stop" }, "stop requires id"],
		[{ action: "result", id: "missing" }, "Unknown subagent"],
		[{ action: "stop", id: "missing" }, "Unknown subagent"],
	] as const)("rejects invalid action arguments: %j", async (params, error) => {
		const fixture = await setup();
		await expect(
			fixture.execute({
				...params,
				...("tasks" in params ? { tasks: [] } : {}),
			}),
		).rejects.toThrow(error);
	});
});
