import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelsPublication, Provider, RefreshModelsContext } from "../src/models.ts";
import type { ModelsStoreEntry } from "../src/models-store.ts";
import { antigravityProvider } from "../src/providers/antigravity.ts";
import { antigravityHeaders, antigravityRequest, parseAntigravityAuth } from "../src/providers/antigravity-client.ts";

const key = JSON.stringify({ token: "secret-access", projectId: "project-a" });
const credential = { type: "api_key" as const, key };
const payload = {
	models: {
		"runtime-low": {
			model: "MODEL_PLACEHOLDER_123",
			displayName: "Live Low",
			maxTokens: 500000,
			maxOutputTokens: 12345,
			supportsImages: true,
			supportsThinking: true,
		},
		"runtime-high": {
			maxTokens: 200000,
			maxOutputTokens: 16384,
			supportsImages: false,
			supportsThinking: false,
		},
		MODEL_PLACEHOLDER_123: {},
		chat_internal: {},
		tab_internal: {},
		"image-only": {},
		internal: { isInternal: true },
		hidden: { apiProvider: "API_PROVIDER_INTERNAL" },
		picture: { displayName: "Image Generator" },
	},
};

function harness(provider: Provider<"antigravity">) {
	let stored: ModelsStoreEntry | undefined;
	const publications: ModelsPublication[] = [];
	return {
		get stored() {
			return stored;
		},
		publications,
		async refresh(options: Partial<RefreshModelsContext> = {}) {
			if (!provider.refreshModels) throw new Error("Missing catalog refresh");
			await provider.refreshModels({
				credential,
				stored,
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async (publication) => {
					publications.push(publication);
					if (publication.persist) stored = publication.persist;
					publication.update?.();
					return true;
				},
				...options,
			});
		},
	};
}

function mockCatalog() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(payload));
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("Antigravity provider", () => {
	it("ships zero-priced runtime IDs and lazy subscription auth offline", async () => {
		const fetch = mockCatalog();
		const provider = antigravityProvider();
		await harness(provider).refresh({ allowNetwork: false });
		expect(fetch).not.toHaveBeenCalled();
		expect(provider.auth?.oauth?.isSubscription).toBe(true);
		expect(provider.getModels().map((model) => model.id)).toEqual([
			"gemini-3.1-pro-low",
			"gemini-pro-agent",
			"gemini-3.8-flash-low",
			"claude-sonnet-4-6",
			"claude-opus-4-6-thinking",
			"gpt-oss-120b-medium",
			"gemini-3.8-flash",
			"gemini-3.1-pro",
			"claude-opus-4-6",
			"gpt-oss-120b",
		]);
		for (const model of provider.getModels()) {
			expect(model).toMatchObject({
				api: "antigravity",
				provider: "antigravity",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
		}
	});

	it("uses map keys without alias routing and honors metadata", async () => {
		const fetch = mockCatalog();
		const provider = antigravityProvider();
		const run = harness(provider);
		await run.refresh();
		expect(provider.getModels().map((model) => model.id)).toEqual(["runtime-low", "runtime-high"]);
		expect(provider.getModels()[0]).toMatchObject({
			contextWindow: 500000,
			maxTokens: 12345,
			reasoning: true,
			input: ["text", "image"],
		});
		expect(provider.getModels()[1]).toMatchObject({
			reasoning: false,
			input: ["text"],
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			expect.objectContaining({
				body: JSON.stringify({ project: "project-a" }),
				headers: expect.objectContaining({
					Authorization: "Bearer secret-access",
				}),
			}),
		);
		expect(JSON.stringify(run.stored)).not.toContain("secret-access");
		expect(run.stored?.checkedAt).toBeGreaterThan(0);
	});

	it("restores a native cache offline and ignores malformed caches", async () => {
		mockCatalog();
		const source = antigravityProvider();
		const run = harness(source);
		await run.refresh();
		const provider = antigravityProvider();
		await harness(provider).refresh({
			stored: run.stored,
			allowNetwork: false,
		});
		expect(provider.getModels()).toEqual(source.getModels());
		for (const models of [null, {}, [null], [{ provider: "antigravity", api: "antigravity", id: "invalid" }]]) {
			const target = antigravityProvider();
			await harness(target).refresh({
				stored: { models } as unknown as ModelsStoreEntry,
				allowNetwork: false,
			});
			expect(target.getModels()).toHaveLength(10);
		}
	});

	it("honors TTL, force, expiration and account changes", async () => {
		const fetch = mockCatalog();
		const run = harness(antigravityProvider());
		await run.refresh();
		await run.refresh();
		expect(fetch).toHaveBeenCalledTimes(1);
		await run.refresh({ force: true });
		expect(fetch).toHaveBeenCalledTimes(2);
		await run.refresh({
			stored: {
				models: run.stored?.models ?? [],
				...run.stored,
				checkedAt: Date.now() - 4 * 60 * 60 * 1000 - 1,
			},
		});
		expect(fetch).toHaveBeenCalledTimes(3);
		await run.refresh({
			credential: {
				type: "api_key",
				key: JSON.stringify({ token: "account-b", projectId: "project-a" }),
			},
		});
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("accepts OAuth access/projectId and keeps freshness across token rotation", async () => {
		const fetch = mockCatalog();
		const run = harness(antigravityProvider());
		const oauth = {
			type: "oauth" as const,
			access: "secret-access",
			refresh: "secret-refresh",
			expires: Date.now() + 60000,
			projectId: "project-a",
		};
		await run.refresh({ credential: oauth });
		await run.refresh({ credential: { ...oauth, access: "rotated-access" } });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(run.stored)).not.toMatch(/secret-access|secret-refresh/);
	});

	it("retains the last good catalog on failures without leaking response secrets", async () => {
		const fetch = mockCatalog();
		const provider = antigravityProvider();
		const run = harness(provider);
		await run.refresh();
		const previous = provider.getModels();
		for (const response of [
			new Response("secret-access", { status: 401 }),
			Response.json({ models: {} }),
			new Response("secret-access"),
		]) {
			fetch.mockResolvedValueOnce(response);
			await expect(run.refresh({ force: true })).rejects.not.toThrow("secret-access");
			expect(provider.getModels()).toEqual(previous);
		}
	});

	it("does not publish rejected or aborted work", async () => {
		const fetch = mockCatalog();
		const provider = antigravityProvider();
		const run = harness(provider);
		await run.refresh({ publish: async () => false });
		expect(provider.getModels()).toHaveLength(10);
		const controller = new AbortController();
		controller.abort();
		fetch.mockClear();
		await run.refresh({ signal: controller.signal });
		expect(fetch).not.toHaveBeenCalled();
		const active = new AbortController();
		fetch.mockImplementationOnce(async () => {
			active.abort();
			return Response.json(payload);
		});
		await expect(run.refresh({ signal: active.signal })).rejects.toBeDefined();
		expect(run.publications).toEqual([]);
		expect(provider.getModels()).toHaveLength(10);
	});
});

describe("Antigravity client helpers", () => {
	it("parses JSON auth without exposing malformed input", () => {
		expect(parseAntigravityAuth(key)).toEqual({
			token: "secret-access",
			projectId: "project-a",
		});
		for (const value of [
			"secret-access",
			"null",
			"{}",
			'{"token":5,"projectId":"p"}',
			'{"token":"secret-access","projectId":" "}',
		]) {
			expect(() => parseAntigravityAuth(value)).toThrow("Invalid Antigravity credentials");
			try {
				parseAntigravityAuth(value);
			} catch (error) {
				expect(String(error)).not.toContain("secret-access");
			}
		}
		expect(antigravityHeaders("token").Authorization).toBe("Bearer token");
	});

	it("shares endpoint overrides and redacts transport errors", async () => {
		vi.stubEnv("ANTIGRAVITY_BASE_URL", "https://example.test/");
		const fetch = mockCatalog();
		await antigravityRequest("/v1internal:fetchAvailableModels", parseAntigravityAuth(key));
		expect(fetch.mock.calls[0][0]).toBe("https://example.test/v1internal:fetchAvailableModels");
		fetch.mockRejectedValueOnce(new Error("secret-access"));
		await expect(antigravityRequest("/v1internal:fetchAvailableModels", parseAntigravityAuth(key))).rejects.toThrow(
			"Antigravity request failed",
		);
		expect(antigravityProvider().getModels()[0].baseUrl).toBe("https://example.test");
	});
});
