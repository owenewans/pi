import { antigravityApi } from "../api/antigravity.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { isModelType, type Provider } from "../models.ts";
import type { AntigravityCompat, AntigravityRuntimeVariant, Model, ThinkingLevelMap } from "../types.ts";
import { antigravityEndpoint, antigravityRequest, parseAntigravityAuth } from "./antigravity-client.ts";

const TTL = 4 * 60 * 60 * 1000;
type NativeModel = Model<"antigravity">;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_MAP_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function runtimeId(id: string): boolean {
	return /^[a-z0-9][a-z0-9_.-]*$/i.test(id) && !/^(MODEL_|chat_|tab_)/i.test(id) && !/image/i.test(id);
}

// baseline limits from pi-antigravity; attribution in antigravity-client.ts.
function baseline(baseUrl: string): NativeModel[] {
	return [
		["gemini-3.8-flash", "Gemini 3.8 Flash", 1048576, 65536, true],
		["claude-sonnet-4-6", "Claude Sonnet 4.6", 250000, 64000, true],
		["claude-opus-4-6", "Claude Opus 4.6", 250000, 64000, true],
		["gpt-oss-120b", "GPT-OSS 120B", 131072, 32768, false],
	].map(([id, name, contextWindow, maxTokens, images]) => ({
		id: id as string,
		name: name as string,
		contextWindow: contextWindow as number,
		maxTokens: maxTokens as number,
		input: images ? ["text", "image"] : ["text"],
		reasoning: true,
		provider: "antigravity",
		api: "antigravity",
		baseUrl,
		cost: { ...ZERO_COST },
	}));
}

type VariantSlot = "minimal" | "low" | "medium" | "high" | "thinking" | "default";

interface ParsedVariant {
	baseId: string;
	baseName: string;
	runtimeId: string;
	slot: VariantSlot;
	meta: AntigravityRuntimeVariant;
}

function parseVariant(id: string, info: Record<string, unknown>): ParsedVariant {
	const rawDisplay = nonEmptyString(info.displayName);
	const displayMatch = rawDisplay?.match(/^(.*?)\s*\((Extra Low|Minimal|Low|Medium|High|Thinking)\)$/i);
	const idMatch = id.match(/^(.*?)-(extra-low|minimal|low|medium|high|thinking)$/);
	const hasThinkingLevel = positive(info.thinkingLevel);
	const shouldCollapse = Boolean(displayMatch || hasThinkingLevel);
	const baseId = shouldCollapse && idMatch ? idMatch[1] : id;
	const baseName = displayMatch ? displayMatch[1].trim() : (rawDisplay ?? baseId);
	const tag = idMatch?.[2] ?? displayMatch?.[2]?.toLowerCase().replace(/\s+/g, "-");

	let slot: VariantSlot = "default";
	if (info.thinkingLevel === 1) slot = "low";
	else if (info.thinkingLevel === 2) slot = "medium";
	else if (info.thinkingLevel === 3) slot = "high";
	else if (tag === "extra-low" || tag === "minimal") slot = "minimal";
	else if (tag === "low") slot = "low";
	else if (tag === "medium") slot = "medium";
	else if (tag === "high") slot = "high";
	else if (tag === "thinking") slot = "thinking";

	const meta: AntigravityRuntimeVariant = {};
	const modelEnum = nonEmptyString(info.model);
	if (modelEnum) meta.modelEnum = modelEnum;
	if (positive(info.thinkingBudget)) meta.thinkingBudget = info.thinkingBudget;
	if (positive(info.minThinkingBudget)) meta.minThinkingBudget = info.minThinkingBudget;
	if (positive(info.thinkingLevel)) meta.thinkingLevel = info.thinkingLevel;
	const apiProvider = nonEmptyString(info.apiProvider);
	if (apiProvider) meta.apiProvider = apiProvider;
	const modelProvider = nonEmptyString(info.modelProvider);
	if (modelProvider) meta.modelProvider = modelProvider;

	return { baseId, baseName, runtimeId: id, slot, meta };
}

function agentModelIds(data: Record<string, unknown>): string[] | undefined {
	const ids: string[] = [];
	const seen = new Set<string>();
	const add = (value: unknown) => {
		if (typeof value === "string" && value && !seen.has(value)) {
			seen.add(value);
			ids.push(value);
		}
	};
	if (Array.isArray(data.agentModelSorts)) {
		for (const sort of data.agentModelSorts) {
			if (!record(sort) || !Array.isArray(sort.groups)) continue;
			for (const group of sort.groups) {
				if (!record(group) || !Array.isArray(group.modelIds)) continue;
				for (const id of group.modelIds) add(id);
			}
		}
	}
	if (!ids.length) return undefined;
	add(data.defaultAgentModelId);
	return ids;
}

function excludedModelIds(data: Record<string, unknown>): Set<string> {
	const excluded = new Set<string>();
	for (const key of ["imageGenerationModelIds", "audioTranscriptionModelIds"] as const) {
		const list = data[key];
		if (!Array.isArray(list)) continue;
		for (const id of list) {
			if (typeof id === "string") excluded.add(id);
		}
	}
	return excluded;
}

function buildThinkingLevelMap(baseId: string, variants: ParsedVariant[]): ThinkingLevelMap | undefined {
	if (variants.length === 1) {
		const only = variants[0];
		if (only.runtimeId === baseId) return undefined;
		return {
			off: only.runtimeId,
			minimal: only.runtimeId,
			low: only.runtimeId,
			medium: only.runtimeId,
			high: only.runtimeId,
		};
	}
	const bySlot = (slot: VariantSlot) => variants.find((entry) => entry.slot === slot)?.runtimeId;
	const low = bySlot("low") ?? bySlot("minimal") ?? bySlot("default") ?? variants[0].runtimeId;
	const minimal = bySlot("minimal") ?? low;
	const medium = bySlot("medium") ?? bySlot("high") ?? low;
	const high = bySlot("high") ?? bySlot("thinking") ?? medium;
	const off = bySlot("default") ?? low;
	return { off, minimal, low, medium, high };
}

function buildCompat(variants: ParsedVariant[]): AntigravityCompat | undefined {
	const variantMap: Record<string, AntigravityRuntimeVariant> = {};
	let apiProvider: string | undefined;
	let modelProvider: string | undefined;
	for (const entry of variants) {
		apiProvider ??= entry.meta.apiProvider;
		modelProvider ??= entry.meta.modelProvider;
		if (Object.keys(entry.meta).length > 0) variantMap[entry.runtimeId] = entry.meta;
	}
	if (!apiProvider && !modelProvider && Object.keys(variantMap).length === 0) return undefined;
	return {
		...(apiProvider ? { apiProvider } : {}),
		...(modelProvider ? { modelProvider } : {}),
		...(Object.keys(variantMap).length > 0 ? { variants: variantMap } : {}),
	};
}

function catalog(data: unknown, defaults: NativeModel[], baseUrl: string): NativeModel[] {
	if (!record(data) || !record(data.models)) throw new Error("Invalid Antigravity model catalog");
	const rawModels = data.models;
	const candidateIds = agentModelIds(data) ?? Object.keys(rawModels);
	const excluded = excludedModelIds(data);

	interface Group {
		model: NativeModel;
		variants: ParsedVariant[];
	}
	const groups = new Map<string, Group>();

	for (const id of candidateIds) {
		const info = rawModels[id];
		if (
			!runtimeId(id) ||
			!record(info) ||
			excluded.has(id) ||
			info.disabled === true ||
			(typeof info.tagTitle === "string" && info.tagTitle.trim().toLowerCase() === "unavailable") ||
			info.isInternal === true ||
			info.apiProvider === "API_PROVIDER_INTERNAL" ||
			info.isImageOnly === true ||
			(typeof info.displayName === "string" && /image/i.test(info.displayName))
		)
			continue;

		const parsed = parseVariant(id, info);
		const fallback = defaults.find((model) => model.id === parsed.baseId || model.id === id);
		const contextWindow = positive(info.maxTokens) ? info.maxTokens : (fallback?.contextWindow ?? 128000);
		const maxTokens = positive(info.maxOutputTokens) ? info.maxOutputTokens : (fallback?.maxTokens ?? 8192);
		const supportsImages =
			(typeof info.supportsImages === "boolean" ? info.supportsImages : fallback?.input.includes("image")) ?? false;
		const supportsThinking =
			(typeof info.supportsThinking === "boolean" ? info.supportsThinking : fallback?.reasoning) ?? false;

		const existing = groups.get(parsed.baseId);
		if (existing) {
			existing.model.contextWindow = Math.max(existing.model.contextWindow, contextWindow);
			existing.model.maxTokens = Math.max(existing.model.maxTokens, maxTokens);
			if (supportsImages && !existing.model.input.includes("image")) existing.model.input.push("image");
			if (supportsThinking) existing.model.reasoning = true;
			existing.variants.push(parsed);
		} else {
			groups.set(parsed.baseId, {
				model: {
					id: parsed.baseId,
					name: parsed.baseName,
					provider: "antigravity",
					api: "antigravity",
					baseUrl,
					cost: { ...ZERO_COST },
					contextWindow,
					maxTokens,
					input: supportsImages ? ["text", "image"] : ["text"],
					reasoning: supportsThinking,
				},
				variants: [parsed],
			});
		}
	}

	if (!groups.size) throw new Error("Antigravity returned no usable models");
	return Array.from(groups.values(), ({ model, variants }) => {
		const thinkingLevelMap = buildThinkingLevelMap(model.id, variants);
		const compat = buildCompat(variants);
		return {
			...model,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			...(compat ? { compat } : {}),
		};
	});
}

function restoreThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	if (!record(value)) return undefined;
	const map: ThinkingLevelMap = {};
	for (const key of THINKING_MAP_KEYS) {
		const entry = value[key];
		if (entry === null || typeof entry === "string") map[key] = entry;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

function restoreCompat(value: unknown): AntigravityCompat | undefined {
	if (!record(value)) return undefined;
	const apiProvider = nonEmptyString(value.apiProvider);
	const modelProvider = nonEmptyString(value.modelProvider);
	let variants: Record<string, AntigravityRuntimeVariant> | undefined;
	if (record(value.variants)) {
		const parsed: Record<string, AntigravityRuntimeVariant> = {};
		for (const [id, raw] of Object.entries(value.variants)) {
			if (!record(raw)) continue;
			const entry: AntigravityRuntimeVariant = {};
			const modelEnum = nonEmptyString(raw.modelEnum);
			if (modelEnum) entry.modelEnum = modelEnum;
			if (positive(raw.thinkingBudget)) entry.thinkingBudget = raw.thinkingBudget;
			if (positive(raw.minThinkingBudget)) entry.minThinkingBudget = raw.minThinkingBudget;
			if (positive(raw.thinkingLevel)) entry.thinkingLevel = raw.thinkingLevel;
			const vApiProvider = nonEmptyString(raw.apiProvider);
			if (vApiProvider) entry.apiProvider = vApiProvider;
			const vModelProvider = nonEmptyString(raw.modelProvider);
			if (vModelProvider) entry.modelProvider = vModelProvider;
			if (Object.keys(entry).length > 0) parsed[id] = entry;
		}
		if (Object.keys(parsed).length > 0) variants = parsed;
	}
	if (!apiProvider && !modelProvider && !variants) return undefined;
	return {
		...(apiProvider ? { apiProvider } : {}),
		...(modelProvider ? { modelProvider } : {}),
		...(variants ? { variants } : {}),
	};
}

function restore(value: unknown, baseUrl: string): NativeModel[] | undefined {
	if (!Array.isArray(value) || !value.length) return undefined;
	if (
		!value.every(
			(model) =>
				record(model) &&
				model.provider === "antigravity" &&
				model.api === "antigravity" &&
				isModelType(model as unknown as NativeModel, "chat") &&
				typeof model.id === "string" &&
				runtimeId(model.id) &&
				typeof model.name === "string" &&
				typeof model.reasoning === "boolean" &&
				positive(model.contextWindow) &&
				positive(model.maxTokens) &&
				Array.isArray(model.input) &&
				model.input.includes("text") &&
				model.input.every((item: unknown) => item === "text" || item === "image"),
		)
	)
		return undefined;
	return (value as NativeModel[]).map((model) => {
		const thinkingLevelMap = restoreThinkingLevelMap(model.thinkingLevelMap);
		const compat = restoreCompat(model.compat);
		return {
			id: model.id,
			name: model.name,
			api: "antigravity",
			provider: "antigravity",
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: [...model.input],
			baseUrl,
			cost: { ...ZERO_COST },
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			...(compat ? { compat } : {}),
		};
	});
}

async function fingerprint(value: string): Promise<string> {
	const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `antigravity-v2:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function antigravityProvider(): Provider<"antigravity"> {
	const baseUrl = antigravityEndpoint();
	const defaults = baseline(baseUrl);
	let dynamicModels: NativeModel[] | undefined;
	const streams = antigravityApi();
	return {
		id: "antigravity",
		name: "Antigravity",
		auth: {
			apiKey: envApiKeyAuth("Antigravity credentials JSON", ["ANTIGRAVITY_API_KEY"]),
			oauth: lazyOAuth({
				name: "Antigravity",
				isSubscription: true,
				load: loadAntigravityOAuth,
			}),
		},
		getModels: () => dynamicModels ?? defaults,
		refreshModels: async (context) => {
			if (context.signal.aborted) return;
			const restored = restore(context.stored?.models, baseUrl);
			if (
				restored &&
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			)
				return;
			if (!context.allowNetwork || context.signal.aborted || !context.credential) return;
			const credential = context.credential;
			const auth =
				credential.type === "api_key"
					? parseAntigravityAuth(credential.key ?? "")
					: parseAntigravityAuth(
							JSON.stringify({
								token: credential.access,
								projectId: credential.projectId,
							}),
						);
			const etag = await fingerprint(
				JSON.stringify([
					credential.type === "oauth" ? credential.refresh : credential.key,
					auth.projectId,
					baseUrl,
				]),
			);
			if (context.signal.aborted) return;
			const checkedAt = context.stored?.checkedAt;
			if (
				!context.force &&
				restored &&
				context.stored?.etag === etag &&
				typeof checkedAt === "number" &&
				Date.now() >= checkedAt &&
				Date.now() - checkedAt < TTL
			)
				return;
			const data = await antigravityRequest("/v1internal:fetchAvailableModels", auth, context.signal);
			if (context.signal.aborted) return;
			const refreshed = catalog(data, defaults, baseUrl);
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now(), etag },
				update: () => {
					dynamicModels = refreshed;
				},
			});
		},
		stream: (model, context, options) => streams.stream(model, context, options),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
	};
}
