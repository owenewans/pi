import { antigravityApi } from "../api/antigravity.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { isModelType, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { antigravityEndpoint, antigravityRequest, parseAntigravityAuth } from "./antigravity-client.ts";

const TTL = 4 * 60 * 60 * 1000;
type NativeModel = Model<"antigravity">;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function runtimeId(id: string): boolean {
	return /^[a-z0-9][a-z0-9_.-]*$/i.test(id) && !/^(MODEL_|chat_|tab_)/i.test(id) && !/image/i.test(id);
}

// baseline limits from pi-antigravity; attribution in antigravity-client.ts.
function baseline(baseUrl: string): NativeModel[] {
	return [
		["gemini-3.1-pro", "Gemini 3.1 Pro", 1048576, 65535, true],
		["gemini-3.8-flash", "Gemini 3.8 Flash", 1048576, 65536, true],
		["claude-sonnet-4-6", "Claude Sonnet 4.6", 200000, 64000, true],
		["claude-opus-4-6", "Claude Opus 4.6", 250000, 64000, true],
		["gpt-oss-120b", "GPT-OSS 120B", 131072, 32768, false],
		["gemini-4-argon", "Gemini 4 Argon", 1048576, 65536, true],
		["gemini-2.5-flash", "Gemini 2.5 Flash", 1048576, 65536, true],
		["gemini-2.5-pro", "Gemini 2.5 Pro", 1048576, 65535, true],
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

function canonicalSpec(rawId: string): { id: string; name: string } | undefined {
	const flashMatch = rawId.match(/^(gemini-3\.[678]-flash)(?:-(?:low|medium|high|tiered))?$/);
	if (flashMatch) {
		const base = flashMatch[1];
		const version = base.slice("gemini-".length);
		return { id: base, name: `Gemini ${version}` };
	}
	if (/^gemini-3\.5-flash(?:-(?:extra-low|low|agent))?$/.test(rawId) || rawId === "gemini-3-flash-agent") {
		return { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" };
	}
	if (/^gemini-3\.1-pro(?:-(?:low|high))?$/.test(rawId) || rawId === "gemini-pro-agent") {
		return { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };
	}
	if (/^claude-opus-4-6(?:-thinking)?$/.test(rawId)) {
		return { id: "claude-opus-4-6", name: "Claude Opus 4.6" };
	}
	if (rawId === "claude-sonnet-4-6") {
		return { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" };
	}
	if (/^gpt-oss-120b(?:-medium)?$/.test(rawId)) {
		return { id: "gpt-oss-120b", name: "GPT-OSS 120B" };
	}
	if (/^gemini-4-argon(?:-disabled)?$/.test(rawId)) {
		return { id: "gemini-4-argon", name: "Gemini 4 Argon" };
	}
	if (/^gemini-2\.5-flash(?:-thinking)?$/.test(rawId)) {
		return { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" };
	}
	return undefined;
}

function catalog(data: unknown, defaults: NativeModel[], baseUrl: string): NativeModel[] {
	if (!record(data) || !record(data.models)) throw new Error("Invalid Antigravity model catalog");
	const modelsMap = new Map<string, NativeModel>();
	for (const [id, info] of Object.entries(data.models)) {
		if (
			!runtimeId(id) ||
			!record(info) ||
			info.isInternal === true ||
			info.apiProvider === "API_PROVIDER_INTERNAL" ||
			info.isImageOnly === true ||
			(typeof info.displayName === "string" && /image/i.test(info.displayName))
		)
			continue;
		const fallback = defaults.find((model) => model.id === id);
		const canonical = canonicalSpec(id);
		const modelId = canonical?.id ?? id;
		const modelName =
			canonical?.name ?? (typeof info.displayName === "string" && info.displayName.trim() ? info.displayName : id);
		const contextWindow = positive(info.maxTokens) ? info.maxTokens : (fallback?.contextWindow ?? 128000);
		const maxTokens = positive(info.maxOutputTokens) ? info.maxOutputTokens : (fallback?.maxTokens ?? 8192);
		const supportsImages =
			(typeof info.supportsImages === "boolean" ? info.supportsImages : fallback?.input.includes("image")) ?? false;
		const supportsThinking =
			(typeof info.supportsThinking === "boolean" ? info.supportsThinking : fallback?.reasoning) ?? true;

		const existing = modelsMap.get(modelId);
		if (existing) {
			existing.contextWindow = Math.max(existing.contextWindow, contextWindow);
			existing.maxTokens = Math.max(existing.maxTokens, maxTokens);
			if (supportsImages && !existing.input.includes("image")) existing.input.push("image");
			if (supportsThinking) existing.reasoning = true;
		} else {
			modelsMap.set(modelId, {
				id: modelId,
				name: modelName,
				provider: "antigravity",
				api: "antigravity",
				baseUrl,
				cost: { ...ZERO_COST },
				contextWindow,
				maxTokens,
				input: supportsImages ? ["text", "image"] : ["text"],
				reasoning: supportsThinking,
			});
		}
	}
	if (!modelsMap.size) throw new Error("Antigravity returned no usable models");
	return Array.from(modelsMap.values());
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
	return (value as NativeModel[]).map((model) => ({
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
	}));
}

async function fingerprint(value: string): Promise<string> {
	const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `antigravity-v1:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
