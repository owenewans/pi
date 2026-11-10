import type { Content, GenerateContentResponse } from "@google/genai";
import { calculateCost } from "../models.ts";
import type {
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import {
	convertMessages,
	convertTools,
	mapStopReasonString,
	resolveGoogleFunctionCallingMode,
	supportsGoogleStrictToolSampling,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

/*
 * Envelope, thinking budgets and legacy schema rules adapted from pi-antigravity
 * revision 3870729 (src/utils/util.ts, src/models/models.ts, src/stream/stream.ts).
 * MIT License
 * Copyright (c) 2026 Rahul Arya
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface AntigravityOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	reasoning?: ThinkingLevel | "off";
}

export function resolveAntigravityModel(id: string, effort: AntigravityOptions["reasoning"]): string {
	const high = effort === "high" || effort === "xhigh" || effort === "max";
	if (/^gemini-3\.[678]-flash$/.test(id)) return `${id}-${high ? "high" : effort === "medium" ? "medium" : "low"}`;
	if (id === "gemini-3.5-flash")
		return high
			? "gemini-3-flash-agent"
			: effort === "medium"
				? "gemini-3.5-flash-low"
				: "gemini-3.5-flash-extra-low";
	if (id === "gemini-3.1-pro") return high ? "gemini-pro-agent" : "gemini-3.1-pro-low";
	if (id === "claude-opus-4-6") return "claude-opus-4-6-thinking";
	if (id === "gpt-oss-120b") return "gpt-oss-120b-medium";
	if (id === "gemini-4-argon") return "gemini-4-argon-disabled";
	if (id === "gemini-2.5-flash") return effort && effort !== "off" ? "gemini-2.5-flash-thinking" : "gemini-2.5-flash";
	return id;
}

function antigravityContents(model: Model<"antigravity">, context: TranscriptContext): Content[] {
	const omitted = new Set<string>();
	const gemini3 = /^gemini-[3-9]/.test(model.id) || model.id === "gemini-pro-agent";
	const signature = (value: string | undefined) => !!value && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
	const messages = context.messages.map((original) => {
		// npm sessions use antigravity-api for the same wire protocol.
		const message =
			original.role === "assistant" && original.provider === "antigravity" && original.api === "antigravity-api"
				? { ...original, api: "antigravity" }
				: original;
		if (gemini3 && message.role === "assistant") {
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (
				calls.length &&
				(message.provider !== model.provider ||
					message.api !== model.api ||
					message.model !== model.id ||
					!signature(calls[0].thoughtSignature) ||
					calls.some((call) => call.thoughtSignature && !signature(call.thoughtSignature)))
			) {
				for (const call of calls) omitted.add(call.id);
				return { ...message, content: message.content.filter((block) => block.type !== "toolCall") };
			}
		}
		if (message.role === "toolResult" && omitted.has(message.toolCallId)) {
			return {
				role: "user" as const,
				timestamp: message.timestamp,
				content: [
					{
						type: "text" as const,
						text: `Previous ${message.toolName} observation:\n${message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n")}`,
					},
					...message.content.filter((part) => part.type === "image"),
				],
			};
		}
		return message;
	});
	const converted = convertMessages(model, { ...context, messages });
	const merged: Content[] = [];
	for (const content of converted) {
		const previous = merged.at(-1);
		if (previous && previous.role === content.role) previous.parts!.push(...(content.parts ?? []));
		else merged.push({ ...content, parts: [...(content.parts ?? [])] });
	}
	if (merged[0]?.role === "model")
		merged.unshift({ role: "user", parts: [{ text: "Continue the authorized task using the following context." }] });
	if (!merged.some((content) => content.role === "user" && content.parts?.some((part) => part.text?.trim()))) {
		merged.unshift({ role: "user", parts: [{ text: "Apply the active instructions to the provided content." }] });
	}
	const last = merged.at(-1);
	if (last?.role === "model") {
		if (last.parts?.some((part) => part.functionCall))
			throw new Error("Antigravity context ends with unresolved tool calls");
		merged.push({
			role: "user",
			parts: [{ text: "Continue the authorized task using the available instructions and context." }],
		});
	}
	// adding a missing user prompt above can produce adjacent user content.
	if (merged.length > 1 && merged[0].role === "user" && merged[1].role === "user") {
		const prompt = merged.shift()!;
		merged[0].parts!.unshift(...(prompt.parts ?? []));
	}
	return merged;
}

async function stableUuid(seed: string): Promise<string> {
	const hash = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(seed));
	const bytes = new Uint8Array(hash, 0, 16);
	bytes[6] = (bytes[6] & 15) | 80;
	bytes[8] = (bytes[8] & 63) | 128;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sessionMetadata(context: TranscriptContext, explicit?: string) {
	const first = context.messages[0];
	const content = first && "content" in first ? first.content : "";
	const seed = explicit?.trim()
		? `session:${explicit.trim()}`
		: first
			? `${first.role}:${first.timestamp || ""}:${typeof content === "string" ? content.slice(0, 64) : JSON.stringify(content[0] ?? "").slice(0, 64)}`
			: globalThis.crypto.randomUUID();
	const sessionSeed = explicit?.trim() || seed;
	let sessionId: string;
	if (/^-?\d+$/.test(sessionSeed) && BigInt(sessionSeed) >= -(1n << 63n) && BigInt(sessionSeed) < 1n << 63n) {
		sessionId = sessionSeed;
	} else {
		const hash = await globalThis.crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`antigravity:session:${sessionSeed}`),
		);
		sessionId = String(new DataView(hash).getBigInt64(0, true));
	}
	return {
		conversationId: await stableUuid(`antigravity:conv:${seed}`),
		trajectoryId: await stableUuid(`antigravity:traj:${seed}`),
		sessionId,
	};
}

function thinkingConfig(id: string, effort: AntigravityOptions["reasoning"]) {
	const enabled = !!effort && effort !== "off";
	if (!enabled)
		return id.includes("argon") || id.startsWith("gemini-4")
			? undefined
			: { includeThoughts: false, thinkingBudget: 0 };
	const high = effort === "high" || effort === "xhigh" || effort === "max";
	let budget = high ? -1 : effort === "medium" ? 4000 : 1000;
	if (id.startsWith("claude-")) budget = 1024;
	else if (id.startsWith("gpt-oss-")) budget = 8192;
	else if (id.startsWith("gemini-3.1-pro") || id === "gemini-pro-agent") budget = high ? 10001 : 1001;
	else if (id.startsWith("gemini-3.5-flash") || id === "gemini-3-flash-agent")
		budget = high ? 10000 : effort === "medium" ? 4000 : 1000;
	return { includeThoughts: true, thinkingBudget: budget };
}

const modelEnums: Record<string, string> = {
	// Gemini 3.8 Flash
	"gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
	"gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
	"gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
	"gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
	"gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
	// Gemini 3.7 Flash
	"gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
	"gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
	"gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
	"gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
	"gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M301",
	// Gemini 3.6 Flash
	"gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
	"gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
	"gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
	"gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
	"gemini-3.6-flash-tiered": "MODEL_PLACEHOLDER_M196",
	// Gemini 3.5 Flash
	"gemini-3.5-flash": "MODEL_PLACEHOLDER_M20",
	"gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
	"gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
	"gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
	// Gemini 3.1 Pro
	"gemini-3.1-pro": "MODEL_PLACEHOLDER_M36",
	"gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
	"gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M37",
	"gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
	// Claude
	"claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
	"claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
	"claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
	// GPT-OSS
	"gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
	"gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

const legacyFields = new Set(["type", "description", "properties", "required", "items", "enum"]);
function legacySchema(value: unknown, root: unknown = value, refs: string[] = [], depth = 0): unknown {
	if (depth > 64) throw new Error("Tool schema exceeds nesting limit");
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => legacySchema(entry, root, refs, depth + 1));
	const schema = value as Record<string, unknown>;
	if (typeof schema.const === "string") return { type: "string", enum: [schema.const] };
	const union = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(union)) {
		const variants = union
			.filter((entry) => entry && typeof entry === "object" && entry.type !== "null")
			.map((entry) => legacySchema(entry, root, refs, depth + 1) as Record<string, unknown>);
		if (variants.length === 1)
			return {
				...(legacySchema({ ...schema, anyOf: undefined, oneOf: undefined }, root, refs, depth + 1) as object),
				...variants[0],
			};
		if (variants.length && variants.every((entry) => entry.type === "string")) {
			const values = variants.flatMap((entry) => (Array.isArray(entry.enum) ? entry.enum : []));
			return {
				type: "string",
				...(variants.every((entry) => Array.isArray(entry.enum)) ? { enum: [...new Set(values)] } : {}),
			};
		}
		if (variants.length && variants.every((entry) => entry.type === "object")) {
			const properties: Record<string, unknown[]> = Object.create(null);
			for (const variant of variants) {
				for (const [key, value] of Object.entries((variant.properties ?? {}) as object)) {
					properties[key] ??= [];
					properties[key].push(value);
				}
			}
			const required = Array.isArray(variants[0].required)
				? variants[0].required.filter((key) =>
						variants.every((entry) => Array.isArray(entry.required) && entry.required.includes(key)),
					)
				: [];
			return {
				type: "object",
				properties: Object.fromEntries(
					Object.entries(properties).map(([key, values]) => [
						key,
						legacySchema({ anyOf: values }, root, refs, depth + 1),
					]),
				),
				...(required.length ? { required } : {}),
			};
		}
		if (variants.length && variants.every((entry) => entry.type === variants[0].type))
			return { type: variants[0].type };
		// calls retain local validation; mixed unions have no legacy wire equivalent.
		return {};
	}
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		if (!ref.startsWith("#/") || refs.includes(ref)) throw new Error(`Unsupported tool schema reference: ${ref}`);
		let target = root;
		for (const segment of ref.slice(2).split("/"))
			target = (target as Record<string, unknown>)?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
		if (target === undefined) throw new Error(`Unresolved tool schema reference: ${ref}`);
		return legacySchema(target, root, [...refs, ref], depth + 1);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(schema)) {
		if (!legacyFields.has(key)) continue;
		if (key === "properties" && entry && typeof entry === "object") {
			result[key] = Object.fromEntries(
				Object.entries(entry).map(([name, property]) => [name, legacySchema(property, root, refs, depth + 1)]),
			);
		} else if (key === "type" && Array.isArray(entry)) result[key] = entry.find((type) => type !== "null");
		else if (key === "enum" && Array.isArray(entry) && !entry.every((item) => typeof item === "string")) continue;
		else result[key] = legacySchema(entry, root, refs, depth + 1);
	}
	return result;
}

async function buildPayload(
	model: Model<"antigravity">,
	context: TranscriptContext,
	project: string,
	options: AntigravityOptions,
) {
	const normalized = collapseSystemMessages(context);
	const contents = antigravityContents(model, normalized);
	const runtimeId = resolveAntigravityModel(model.id, options.reasoning);
	const tools = getCurrentTools(normalized.messages);
	const legacy = /^(claude-|gpt-oss-)/.test(model.id);
	const strict = supportsGoogleStrictToolSampling(model.id);
	const declarations = convertTools(tools, false, strict);
	if (legacy)
		for (const declaration of declarations?.[0].functionDeclarations ?? []) {
			declaration.parameters = legacySchema(declaration.parametersJsonSchema);
			delete declaration.parametersJsonSchema;
		}
	const system = getInitialSystemMessage(normalized.messages);
	const systemText = system ? sanitizeSurrogates(getSystemMessageText(system)) : "";
	const { conversationId, trajectoryId, sessionId } = await sessionMetadata(context, options.sessionId);
	const step = Math.max(1, contents.length);
	const requestIndex = context.messages.filter(
		(message) => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
	).length;
	const labels: Record<string, string> = {
		last_step_index: String(Math.max(0, contents.length - 1)),
		request_id: `${trajectoryId}-${requestIndex}`,
		trajectory_id: trajectoryId,
		used_claude: String(model.id.startsWith("claude-")),
		used_claude_conservative: String(model.id.startsWith("claude-")),
		used_non_gemini_model: String(!model.id.startsWith("gemini-")),
	};
	if (modelEnums[runtimeId]) labels.model_enum = modelEnums[runtimeId];
	if (step > 1) labels.last_execution_id = await stableUuid(`antigravity:exec:${trajectoryId}:${step - 1}`);
	const mode = tools.length ? resolveGoogleFunctionCallingMode(tools, options.toolChoice, strict) : undefined;
	return {
		project,
		model: runtimeId,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`,
		request: {
			contents,
			sessionId,
			labels,
			...(systemText && {
				systemInstruction: { role: "user", parts: [{ text: systemText }] },
			}),
			...(declarations && { tools: declarations }),
			...(mode && { toolConfig: { functionCallingConfig: { mode } } }),
			generationConfig: {
				maxOutputTokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
				...(options.temperature !== undefined && {
					temperature: options.temperature,
				}),
				...(model.reasoning && {
					thinkingConfig: thinkingConfig(runtimeId, options.reasoning),
				}),
			},
		},
	};
}

async function* sse(reader: ReadableStreamDefaultReader<Uint8Array>, wait: <T>(operation: Promise<T>) => Promise<T>) {
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	const lineData = (line: string) => {
		if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
	};
	for (;;) {
		const { value, done } = await wait(reader.read());
		buffer += decoder.decode(value, { stream: !done });
		for (;;) {
			const match = /\r\n|\r|\n/.exec(buffer);
			if (!match) break;
			if (!done && match[0] === "\r" && match.index === buffer.length - 1) break;
			const line = buffer.slice(0, match.index);
			buffer = buffer.slice(match.index + match[0].length);
			if (line === "") {
				if (data.length) yield data.join("\n");
				data = [];
			} else lineData(line);
		}
		if (done) {
			if (buffer) lineData(buffer);
			if (data.length) yield data.join("\n");
			return;
		}
	}
}

export const stream: StreamFunction<"antigravity", AntigravityOptions> = (model, context, options = {}) => {
	const events = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "antigravity",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
	void (async () => {
		const controller = new AbortController();
		const abort = () => controller.abort(new Error("Request aborted"));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		const timeout =
			typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
				? options.timeoutMs
				: 120000;
		const wait = async <T>(operation: Promise<T>): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let rejectAbort: () => void = () => {};
			try {
				return await Promise.race([
					operation,
					new Promise<never>((_, reject) => {
						rejectAbort = () => reject(controller.signal.reason ?? new Error("Request aborted"));
						controller.signal.addEventListener("abort", rejectAbort, {
							once: true,
						});
						if (controller.signal.aborted) rejectAbort();
						timer = setTimeout(() => controller.abort(new Error("Antigravity request timed out")), timeout);
					}),
				]);
			} finally {
				clearTimeout(timer);
				controller.signal.removeEventListener("abort", rejectAbort);
			}
		};
		try {
			if (controller.signal.aborted) throw controller.signal.reason;
			let credentials: { token?: unknown; projectId?: unknown };
			try {
				credentials = JSON.parse(options.apiKey ?? "");
			} catch {
				throw new Error("Antigravity apiKey must be JSON {token,projectId}");
			}
			if (
				typeof credentials?.token !== "string" ||
				!credentials.token.trim() ||
				typeof credentials.projectId !== "string" ||
				!credentials.projectId.trim()
			)
				throw new Error("Antigravity apiKey requires token and projectId");
			let payload: unknown = await wait(buildPayload(model, context, credentials.projectId, options));
			const replacement = await options.onPayload?.(payload, model);
			if (replacement !== undefined) payload = replacement;
			const base = (model.baseUrl || "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, "");
			const headers = providerHeadersToRecord(
				{
					Authorization: `Bearer ${credentials.token}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					"User-Agent":
						"antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)",
				},
				model.headers,
				options.headers,
			);
			const response = await wait(
				(options.fetch ?? globalThis.fetch)(`${base}/v1internal:streamGenerateContent?alt=sse`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: controller.signal,
				}).then((response) => {
					if (controller.signal.aborted) {
						void response.body?.cancel().catch(() => {});
						throw controller.signal.reason;
					}
					return response;
				}),
			);
			reader = response.body?.getReader();
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!reader) throw new Error(`Antigravity HTTP ${response.status}: missing response body`);
			if (!response.ok) {
				const decoder = new TextDecoder();
				let text = "";
				while (text.length < 65536) {
					const next = await wait(reader.read());
					if (next.done) break;
					text += decoder.decode(next.value, { stream: true });
				}
				let detail = text.trim();
				try {
					const parsed = JSON.parse(detail) as { error?: { message?: string } };
					if (parsed?.error?.message) detail = parsed.error.message;
				} catch {}
				throw new Error(`Antigravity HTTP ${response.status}: ${detail}`);
			}
			events.push({ type: "start", partial: output });
			let current: TextContent | ThinkingContent | undefined;
			const endBlock = () => {
				if (!current) return;
				const contentIndex = output.content.length - 1;
				if (current.type === "text")
					events.push({
						type: "text_end",
						contentIndex,
						content: current.text,
						partial: output,
					});
				else
					events.push({
						type: "thinking_end",
						contentIndex,
						content: current.thinking,
						partial: output,
					});
				current = undefined;
			};
			for await (const data of sse(reader, wait)) {
				if (data.trim() === "[DONE]") break;
				const raw = JSON.parse(data) as GenerateContentResponse & {
					response?: GenerateContentResponse;
					error?: unknown;
				};
				await options.onProviderStreamEvent?.(raw, model);
				const chunk = raw.response ?? raw;
				if (raw.error || (chunk as { error?: unknown }).error)
					throw new Error(
						`Antigravity stream error: ${JSON.stringify(raw.error ?? (chunk as { error?: unknown }).error)}`,
					);
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.functionCall) {
						endBlock();
						const call: ToolCall = {
							type: "toolCall",
							id: part.functionCall.id || globalThis.crypto.randomUUID(),
							name: part.functionCall.name || "",
							arguments: (part.functionCall.args ?? {}) as ToolCall["arguments"],
							...(part.thoughtSignature && {
								thoughtSignature: part.thoughtSignature,
							}),
						};
						if (output.content.some((block) => block.type === "toolCall" && block.id === call.id))
							call.id = globalThis.crypto.randomUUID();
						output.content.push(call);
						const contentIndex = output.content.length - 1;
						events.push({
							type: "toolcall_start",
							contentIndex,
							partial: output,
						});
						events.push({
							type: "toolcall_delta",
							contentIndex,
							delta: JSON.stringify(call.arguments),
							partial: output,
						});
						events.push({
							type: "toolcall_end",
							contentIndex,
							toolCall: call,
							partial: output,
						});
					} else if (part.text !== undefined || part.thoughtSignature) {
						const thinking =
							part.thought === true ||
							(part.text === undefined && part.thought === undefined && current?.type === "thinking");
						if (
							current &&
							((current.type === "thinking") !== thinking ||
								(current.type === "text" ? current.textSignature : current.thinkingSignature))
						)
							endBlock();
						if (!current) {
							current = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
							output.content.push(current);
							events.push({
								type: thinking ? "thinking_start" : "text_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						const delta = part.text ?? "";
						if (current.type === "thinking") {
							current.thinking += delta;
							if (part.thoughtSignature) current.thinkingSignature = part.thoughtSignature;
						} else {
							current.text += delta;
							if (part.thoughtSignature) current.textSignature = part.thoughtSignature;
						}
						events.push({
							type: thinking ? "thinking_delta" : "text_delta",
							contentIndex: output.content.length - 1,
							delta,
							partial: output,
						});
					}
				}
				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReasonString(candidate.finishReason);
				}
				if (chunk.promptFeedback?.blockReason)
					throw new Error(`Antigravity prompt blocked: ${chunk.promptFeedback.blockReason}`);
				if (chunk.usageMetadata) {
					const usage = chunk.usageMetadata;
					output.usage.input = Math.max(0, (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0));
					output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
					output.usage.cacheRead = usage.cachedContentTokenCount ?? 0;
					output.usage.reasoning = usage.thoughtsTokenCount ?? 0;
					output.usage.totalTokens =
						usage.totalTokenCount ?? output.usage.input + output.usage.output + output.usage.cacheRead;
					calculateCost(model, output.usage);
				}
			}
			endBlock();
			if (controller.signal.aborted) throw controller.signal.reason;
			if (output.stopReason === "pending") throw new Error("Antigravity stream ended without a finish reason");
			if (output.stopReason === "error" || output.stopReason === "aborted")
				throw new Error(`Provider stopped with: ${output.rawStopReason}`);
			if (output.stopReason === "stop" && output.content.some((block) => block.type === "toolCall"))
				output.stopReason = "toolUse";
			events.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			let message = error instanceof Error ? error.message : String(error);
			try {
				const credentials = JSON.parse(options.apiKey ?? "{}");
				for (const secret of [credentials?.token, options.apiKey]) {
					if (typeof secret === "string" && secret) message = message.split(secret).join("[redacted]");
				}
			} catch {
				/* invalid credentials are never echoed */
			}
			output.errorMessage = message.slice(0, 4000);
			events.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			void reader?.cancel().catch(() => {});
			controller.abort();
			options.signal?.removeEventListener("abort", abort);
			events.end();
		}
	})();
	return events;
};

export const streamSimple: StreamFunction<"antigravity", SimpleStreamOptions> = (model, context, options) => {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return stream(model, context, {
		...buildBaseOptions(model, context, options),
		toolChoice: options.toolChoice,
		reasoning: options.reasoning,
	});
};
