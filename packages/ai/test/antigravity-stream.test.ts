import { createHash } from "node:crypto";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { antigravityApi } from "../src/api/antigravity.lazy.ts";
import { stream, streamSimple } from "../src/api/antigravity.ts";
import { normalizeContext } from "../src/compat.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";

const model: Model<"antigravity"> = {
	id: "claude-sonnet-4-6",
	name: "Claude",
	api: "antigravity",
	provider: "antigravity",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const context = normalizeContext({
	messages: [
		{
			role: "user",
			content: "Keep this natural language unchanged.",
			timestamp: 1,
		},
	],
});
const apiKey = JSON.stringify({ token: "access-token", projectId: "project" });
const candidate = (parts: unknown[], finishReason?: string) => ({
	candidates: [{ content: { parts }, ...(finishReason && { finishReason }) }],
});
function mockFetch(
	events: unknown[],
	options: {
		wrapped?: boolean;
		chunkSize?: number;
		done?: boolean;
		crlf?: boolean;
	} = {},
) {
	const newline = options.crlf ? "\r\n" : "\n";
	const text =
		events
			.map((event) => `data: ${JSON.stringify(options.wrapped ? { response: event } : event)}${newline}${newline}`)
			.join("") + (options.done ? `data: [DONE]${newline}${newline}` : "");
	const bytes = new TextEncoder().encode(text);
	const cancel = vi.fn();
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						const size = options.chunkSize ?? bytes.length;
						for (let offset = 0; offset < bytes.length; offset += size)
							controller.enqueue(bytes.slice(offset, offset + size));
						controller.close();
					},
					cancel,
				}),
				{ headers: { "x-test": "yes" } },
			),
	);
	return { fetch, cancel };
}

describe("Antigravity native streaming", () => {
	it.each([false, true])("handles byte-split UTF-8 and CRLF SSE, wrapped=%s", async (wrapped) => {
		const chunks = [
			candidate([{ text: "hé" }]),
			{
				...candidate([{ text: "llo" }], "STOP"),
				responseId: "response-id",
				usageMetadata: {
					promptTokenCount: 10,
					candidatesTokenCount: 3,
					thoughtsTokenCount: 2,
					cachedContentTokenCount: 4,
					totalTokenCount: 15,
				},
			},
		];
		const { fetch } = mockFetch(chunks, {
			wrapped,
			crlf: true,
			chunkSize: 1,
			done: true,
		});
		const observer = vi.fn();
		const events: AssistantMessageEvent[] = [];
		const source = stream(model, context, {
			apiKey,
			fetch,
			onProviderStreamEvent: observer,
		});
		for await (const event of source) events.push(event);
		const result = await source.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "héllo" }]);
		expect(result.responseId).toBe("response-id");
		expect(result.usage).toMatchObject({
			input: 6,
			output: 5,
			reasoning: 2,
			cacheRead: 4,
			totalTokens: 15,
		});
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(observer).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0][0]).toBe("https://example.invalid/v1internal:streamGenerateContent?alt=sse");
		const init = fetch.mock.calls[0][1] ?? {};
		expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-token");
		const payload = JSON.parse(init.body as string);
		expect(payload).toMatchObject({
			model: model.id,
			project: "project",
			requestType: "agent",
			userAgent: "antigravity",
		});
		expect(payload.request.contents[0].parts).toEqual([{ text: "Keep this natural language unchanged." }]);
	});

	it("uses host fetch and default endpoint, without fallback", async () => {
		const { fetch } = mockFetch([candidate([{ text: "ok" }], "STOP")]);
		vi.stubGlobal("fetch", fetch);
		try {
			const result = await stream({ ...model, baseUrl: "" }, context, {
				apiKey,
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(fetch.mock.calls[0][0]).toBe(
				"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("emits thinking signatures, tool calls, and replays signed history with images", async () => {
		const { fetch } = mockFetch([
			candidate([{ thought: true, text: "consider" }]),
			candidate([{ thoughtSignature: "YWJjZA==" }]),
			candidate(
				[
					{
						functionCall: {
							id: "call-1",
							name: "inspect",
							args: { path: "x" },
						},
						thoughtSignature: "dG9vbA==",
					},
				],
				"STOP",
			),
		]);
		const events: string[] = [];
		const source = stream(model, context, { apiKey, fetch, reasoning: "high" });
		for await (const event of source) events.push(event.type);
		const result = await source.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "consider", thinkingSignature: "YWJjZA==" },
			{
				type: "toolCall",
				id: "call-1",
				name: "inspect",
				arguments: { path: "x" },
				thoughtSignature: "dG9vbA==",
			},
		]);
		expect(events).toContain("thinking_end");
		expect(events).toContain("toolcall_end");
		const next = mockFetch([candidate([{ text: "done" }], "STOP")]);
		const history = normalizeContext({
			messages: [
				...context.messages,
				result,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "inspect",
					content: [
						{ type: "text", text: "image follows" },
						{ type: "image", mimeType: "image/png", data: "aW1n" },
					],
					isError: false,
					timestamp: 2,
				},
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", mimeType: "image/png", data: "dXNlcg==" },
					],
					timestamp: 3,
				},
			],
		});
		await stream(model, history, { apiKey, fetch: next.fetch }).result();
		const payload = JSON.parse(next.fetch.mock.calls[0][1]?.body as string);
		expect(payload.request.contents[1].parts).toEqual([
			{ thought: true, text: "consider", thoughtSignature: "YWJjZA==" },
			{
				functionCall: { name: "inspect", args: { path: "x" }, id: "call-1" },
				thoughtSignature: "dG9vbA==",
			},
		]);
		expect(payload.request.contents[2].parts[0].functionResponse).toMatchObject({
			id: "call-1",
			response: { output: "image follows" },
			parts: [{ inlineData: { mimeType: "image/png", data: "aW1n" } }],
		});
		expect(payload.request.contents[2].parts[2].inlineData.data).toBe("dXNlcg==");
	});

	it.each(["claude-sonnet-4-6", "gpt-oss-120b-medium", "gemini-3.8-flash-high"])(
		"uses current system/tools and correct schema field for %s",
		async (id) => {
			const tool = {
				name: "inspect",
				description: "Inspect",
				parameters: Type.Object({
					path: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				}),
			};
			const current = normalizeContext({
				systemPrompt: "system instruction",
				tools: [tool],
				messages: context.messages,
			});
			const { fetch } = mockFetch([candidate([], "STOP")]);
			await stream({ ...model, id }, current, {
				apiKey,
				fetch,
				toolChoice: "any",
				sessionId: "session",
				reasoning: "high",
			}).result();
			const payload = JSON.parse(fetch.mock.calls[0][1]?.body as string);
			expect(payload.model).toBe(id);
			expect(payload.request.systemInstruction.parts).toEqual([{ text: "system instruction" }]);
			expect(payload.request.toolConfig.functionCallingConfig.mode).toBe("ANY");
			const declaration = payload.request.tools[0].functionDeclarations[0];
			if (id.startsWith("gemini-")) expect(declaration.parametersJsonSchema).toBeDefined();
			else {
				expect(declaration.parameters).toBeDefined();
				expect(declaration.parametersJsonSchema).toBeUndefined();
				expect(JSON.stringify(declaration.parameters)).not.toContain("anyOf");
			}
			expect(payload.request.labels).toMatchObject({
				last_step_index: "0",
				used_claude: String(id.startsWith("claude-")),
			});
			expect(payload.request.sessionId).toMatch(/^-?\d+$/);
			expect(payload.requestId).toMatch(/^agent\//);
		},
	);

	it.each(["session", "-1", "9223372036854775807", "9223372036854775808"])(
		"preserves stable metadata with Web Crypto for session %s",
		async (sessionId) => {
			const { fetch } = mockFetch([candidate([{ text: "ok" }], "STOP")]);
			const result = await stream(model, context, { apiKey, fetch, sessionId }).result();
			expect(result.stopReason).toBe("stop");
			const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
			const uuid = (seed: string) => {
				const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
				bytes[6] = (bytes[6] & 15) | 80;
				bytes[8] = (bytes[8] & 63) | 128;
				const hex = bytes.toString("hex");
				return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
			};
			const trajectory = uuid(`antigravity:traj:session:${sessionId}`);
			expect(payload.request.labels.trajectory_id).toBe(trajectory);
			expect(payload.requestId.split("/")[1]).toBe(uuid(`antigravity:conv:session:${sessionId}`));
			const numeric =
				/^-?\d+$/.test(sessionId) && BigInt(sessionId) >= -(1n << 63n) && BigInt(sessionId) < 1n << 63n;
			expect(payload.request.sessionId).toBe(
				numeric
					? sessionId
					: String(createHash("sha256").update(`antigravity:session:${sessionId}`).digest().readBigInt64LE()),
			);
		},
	);

	it("invokes callbacks in order and sends replacement payload", async () => {
		const { fetch } = mockFetch([candidate([{ text: "ok" }], "STOP")]);
		const order: string[] = [];
		const result = await stream(model, context, {
			apiKey,
			fetch,
			onPayload: async () => {
				order.push("payload");
				return { replaced: true };
			},
			onResponse: async (response) => {
				expect(response).toMatchObject({
					status: 200,
					headers: { "x-test": "yes" },
				});
				order.push("response");
			},
			onProviderStreamEvent: () => {
				order.push("event");
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(order).toEqual(["payload", "response", "event"]);
		expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
			replaced: true,
		});
	});

	it.each([
		{
			chunks: [candidate([{ text: "unfinished" }])],
			message: "without a finish reason",
		},
		{ chunks: [{ error: { message: "denied" } }], message: "denied" },
		{ chunks: [candidate([], "SAFETY")], message: "SAFETY" },
	])("reports stream errors: $message", async ({ chunks, message }) => {
		const result = await stream(model, context, {
			apiKey,
			fetch: mockFetch(chunks).fetch,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(message);
	});

	it("preserves MAX_TOKENS with tools", async () => {
		const { fetch } = mockFetch([candidate([{ functionCall: { name: "inspect", args: {} } }], "MAX_TOKENS")]);
		expect((await stream(model, context, { apiKey, fetch }).result()).stopReason).toBe("length");
	});

	it("reports malformed SSE and HTTP errors, including onResponse", async () => {
		for (const response of [new Response("data: broken\n\n"), new Response("denied", { status: 403 })]) {
			const onResponse = vi.fn();
			const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
			const result = await stream(model, context, {
				apiKey,
				fetch,
				onResponse,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(onResponse).toHaveBeenCalledOnce();
			expect(fetch).toHaveBeenCalledOnce();
		}
	});

	it("aborts before fetch and during a stalled body, cancelling the reader", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.fn<typeof globalThis.fetch>();
		expect(
			(
				await stream(model, context, {
					apiKey,
					fetch,
					signal: controller.signal,
				}).result()
			).stopReason,
		).toBe("aborted");
		expect(fetch).not.toHaveBeenCalled();
		const active = new AbortController();
		const cancel = vi.fn();
		const stalledFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel })));
		const source = stream(model, context, {
			apiKey,
			fetch: stalledFetch,
			signal: active.signal,
			onResponse: () => {
				active.abort();
			},
		});
		expect((await source.result()).stopReason).toBe("aborted");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("bounds header and stream stalls, including transports ignoring abort", async () => {
		const stalledFetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
		const first = await stream(model, context, {
			apiKey,
			fetch: stalledFetch,
			timeoutMs: 10,
		}).result();
		expect(first.errorMessage).toContain("timed out");
		const cancel = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel })));
		const second = await stream(model, context, {
			apiKey,
			fetch,
			timeoutMs: 10,
		}).result();
		expect(second.errorMessage).toContain("timed out");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("supports lazy and simple stream contracts", async () => {
		expect(() => streamSimple(model, context)).toThrow("No API key");
		const { fetch } = mockFetch([candidate([], "STOP")]);
		const result = await antigravityApi().streamSimple(model, context, { apiKey, fetch, reasoning: "high" }).result();
		expect(result.stopReason).toBe("stop");
		const payload = JSON.parse(fetch.mock.calls[0][1]?.body as string);
		expect(payload.request.generationConfig.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 1024,
		});
	});
});

it.each([
	["gemini-3.8-flash", "high", "gemini-3.8-flash-high"],
	["gemini-3.1-pro", "high", "gemini-pro-agent"],
	["gemini-3.1-pro", "low", "gemini-3.1-pro-low"],
	["claude-opus-4-6", "off", "claude-opus-4-6-thinking"],
	["gpt-oss-120b", "medium", "gpt-oss-120b-medium"],
] as const)("routes legacy model %s at %s without error fallback", async (id, reasoning, runtime) => {
	const next = mockFetch([candidate([{ text: "done" }], "STOP")]);
	const result = await stream({ ...model, id }, context, { apiKey, fetch: next.fetch, reasoning }).result();
	expect(result.stopReason).toBe("stop");
	expect(JSON.parse(String(next.fetch.mock.calls[0][1]?.body)).model).toBe(runtime);
	expect(next.fetch).toHaveBeenCalledTimes(1);
});

it("continues assistant-ending context and merges adjacent user turns", async () => {
	const next = mockFetch([candidate([{ text: "done" }], "STOP")]);
	const history = normalizeContext({
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "second", timestamp: 2 },
			{
				role: "assistant",
				content: [{ type: "text", text: "progress" }],
				api: "antigravity",
				provider: "antigravity",
				model: model.id,
				stopReason: "stop",
				timestamp: 3,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		],
	});
	expect((await stream(model, history, { apiKey, fetch: next.fetch }).result()).stopReason).toBe("stop");
	const payload = JSON.parse(String(next.fetch.mock.calls[0][1]?.body));
	expect(payload.request.contents.map((item: { role: string }) => item.role)).toEqual(["user", "model", "user"]);
	expect(payload.request.contents[0].parts).toEqual([{ text: "first" }, { text: "second" }]);
	expect(payload.request.contents.at(-1).parts[0].text).toContain("Continue the authorized task");
});

it("turns unsigned cross-provider Gemini tool calls into observations", async () => {
	const next = mockFetch([candidate([{ text: "done" }], "STOP")]);
	const assistant = {
		role: "assistant" as const,
		api: "openai-completions",
		provider: "openai",
		model: "other",
		content: [{ type: "toolCall" as const, id: "old-tool", name: "inspect", arguments: { path: "x" } }],
		stopReason: "toolUse" as const,
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const history = normalizeContext({
		messages: [
			...context.messages,
			assistant,
			{
				role: "toolResult",
				toolCallId: "old-tool",
				toolName: "inspect",
				content: [{ type: "text", text: "verified file" }],
				isError: false,
				timestamp: 2,
			},
		],
	});
	const result = await stream({ ...model, id: "gemini-3.8-flash-low" }, history, {
		apiKey,
		fetch: next.fetch,
	}).result();
	expect(result.stopReason).toBe("stop");
	const payload = JSON.parse(String(next.fetch.mock.calls[0][1]?.body));
	expect(JSON.stringify(payload.request.contents)).not.toContain("functionCall");
	expect(JSON.stringify(payload.request.contents)).not.toContain("functionResponse");
	expect(JSON.stringify(payload.request.contents)).toContain("verified file");
});

it("redacts OAuth access tokens from provider error bodies", async () => {
	const result = await stream(model, context, {
		apiKey,
		fetch: async () => new Response("access-token rejected", { status: 403 }),
	}).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).not.toContain("access-token");
});

it("converts literal unions for native action and role schemas on Claude", async () => {
	const next = mockFetch([candidate([{ text: "done" }], "STOP")]);
	const withTools = normalizeContext({
		messages: [...context.messages],
		tools: [
			{
				name: "fixture",
				description: "fixture",
				parameters: Type.Object({
					action: Type.Union([Type.Literal("start"), Type.Literal("stop")]),
					items: Type.Array(Type.Object({ role: Type.Union([Type.Literal("scout"), Type.Literal("worker")]) })),
				}),
			},
		],
	});
	expect((await stream(model, withTools, { apiKey, fetch: next.fetch }).result()).stopReason).toBe("stop");
	const schema = JSON.parse(String(next.fetch.mock.calls[0][1]?.body)).request.tools[0].functionDeclarations[0]
		.parameters;
	expect(schema.properties.action).toEqual({ type: "string", enum: ["start", "stop"] });
	expect(schema.properties.items.items.properties.role).toEqual({ type: "string", enum: ["scout", "worker"] });
});

it("merges discriminated object variants for native hashline edits", async () => {
	const next = mockFetch([candidate([{ text: "done" }], "STOP")]);
	const withTools = normalizeContext({
		messages: [...context.messages],
		tools: [
			{
				name: "fixture",
				description: "fixture",
				parameters: Type.Object({
					edits: Type.Array(
						Type.Union([
							Type.Object({
								op: Type.Literal("replace"),
								start: Type.String(),
								lines: Type.Array(Type.String()),
							}),
							Type.Object({ op: Type.Literal("append"), lines: Type.Array(Type.String()) }),
						]),
					),
				}),
			},
		],
	});
	expect((await stream(model, withTools, { apiKey, fetch: next.fetch }).result()).stopReason).toBe("stop");
	const schema = JSON.parse(String(next.fetch.mock.calls[0][1]?.body)).request.tools[0].functionDeclarations[0]
		.parameters.properties.edits.items;
	expect(schema.properties.op.enum).toEqual(["replace", "append"]);
	expect(schema.required).toEqual(["op", "lines"]);
});

it("replays signed tool history from npm Antigravity sessions", async () => {
	const next = mockFetch([candidate([{ text: "done" }], "STOP")]);
	const id = "gemini-3.8-flash-low";
	const history = normalizeContext({
		messages: [
			...context.messages,
			{
				role: "assistant",
				provider: "antigravity",
				api: "antigravity-api",
				model: id,
				content: [
					{ type: "toolCall", id: "old-call", name: "inspect", arguments: {}, thoughtSignature: "dG9vbA==" },
				],
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			{
				role: "toolResult",
				toolCallId: "old-call",
				toolName: "inspect",
				content: [{ type: "text", text: "old observation" }],
				isError: false,
				timestamp: 2,
			},
		],
	});
	expect((await stream({ ...model, id }, history, { apiKey, fetch: next.fetch }).result()).stopReason).toBe("stop");
	const parts = JSON.parse(String(next.fetch.mock.calls[0][1]?.body)).request.contents[1].parts;
	expect(parts[0].functionCall.name).toBe("inspect");
	expect(parts[0].thoughtSignature).toBe("dG9vbA==");
});
