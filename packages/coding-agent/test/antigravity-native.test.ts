import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("native Antigravity integration", () => {
	it("exposes subscription OAuth and fallback models without an extension or network", async () => {
		const auth = AuthStorage.inMemory();
		await auth.modify("antigravity", async () => ({
			type: "oauth",
			access: "fixture-access",
			refresh: "fixture-refresh",
			expires: Date.now() + 3600000,
			projectId: "fixture-project",
			email: "fixture@example.invalid",
		}));
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline fixture"));
		try {
			const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
			const provider = runtime.getProvider("antigravity");
			expect(provider?.name).toBe("Antigravity");
			expect(provider?.auth.oauth?.isSubscription).toBe(true);
			expect(runtime.hasConfiguredAuth("antigravity")).toBe(true);
			expect(runtime.isUsingOAuth("antigravity")).toBe(true);
			const models = runtime.getModels("antigravity");
			expect(models.some((model) => model.id.startsWith("gemini-"))).toBe(true);
			expect(models.some((model) => model.id.startsWith("claude-"))).toBe(true);
			expect(models.every((model) => model.api === "antigravity")).toBe(true);
			const resolved = await runtime.getAuth("antigravity");
			expect(JSON.parse(resolved?.auth.apiKey ?? "null")).toEqual({
				token: "fixture-access",
				projectId: "fixture-project",
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
});
