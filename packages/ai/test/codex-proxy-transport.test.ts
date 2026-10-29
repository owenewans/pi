// verifies that a configured proxy never leaves Codex on a direct WebSocket.
import { afterEach, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { setProviderProxy } from "../src/utils/proxy-routing.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

afterEach(() => {
	setProviderProxy(undefined);
	vi.unstubAllGlobals();
});

it("uses the HTTP transport rather than opening a direct WebSocket", async () => {
	setProviderProxy("socks5h://127.0.0.1:1080");
	const socket = vi.fn();
	vi.stubGlobal("WebSocket", socket);
	const fetch = vi.fn(async () => new Response("fixture error", { status: 400 }));
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.signature`;
	const result = await stream(
		model,
		normalizeContext({ messages: [{ role: "user", content: "test", timestamp: 1 }] }),
		{ apiKey: token, fetch, maxRetries: 0 },
	).result();
	expect(result.stopReason).toBe("error");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(socket).not.toHaveBeenCalled();
});
