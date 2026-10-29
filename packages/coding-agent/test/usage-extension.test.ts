import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import usageExtension, { fetchAccountUsage, formatAccountUsage } from "../src/extensions/usage/index.ts";

vi.mock("../src/core/http-dispatcher.ts", () => ({
	fetchService: (_service: string, input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("account usage", () => {
	it("registers /usage as a native command", async () => {
		const extension = await loadExtensionFromFactory(
			usageExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:usage",
		);
		expect(extension.commands.get("usage")?.description).toBe("Show Claude or ChatGPT account quota");
	});

	it("reads Claude's five-hour quota with OAuth headers", async () => {
		const request = vi
			.fn()
			.mockResolvedValue(Response.json({ five_hour: { utilization: 25, resets_at: "2026-10-29T06:00:00Z" } }));
		vi.stubGlobal("fetch", request);
		await expect(fetchAccountUsage("anthropic", "fixture-token")).resolves.toEqual({
			remaining: 75,
			resetsAt: Date.parse("2026-10-29T06:00:00Z"),
		});
		expect(request).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", {
			headers: { Authorization: "Bearer fixture-token", "anthropic-beta": "oauth-2025-04-20" },
			signal: expect.any(AbortSignal),
		});
	});

	it("reads only ChatGPT's primary window and scopes the account", async () => {
		const claims = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
		).toString("base64url");
		const token = `header.${claims}.signature`;
		const request = vi.fn().mockResolvedValue(
			Response.json({
				rate_limit: {
					primary_window: { used_percent: 60, reset_at: 1000 },
					secondary_window: { used_percent: 99 },
				},
			}),
		);
		vi.stubGlobal("fetch", request);
		await expect(fetchAccountUsage("openai-codex", token)).resolves.toEqual({ remaining: 40, resetsAt: 1_000_000 });
		expect(request).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", {
			headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": "fixture-account" },
			signal: expect.any(AbortSignal),
		});
	});

	it("accepts opaque tokens and clamps reported quota", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ rate_limit: { primary_window: { used_percent: 120 } } })),
		);
		await expect(fetchAccountUsage("openai-codex", "opaque")).resolves.toEqual({ remaining: 0 });
	});

	it.each([null, [], {}, { five_hour: { utilization: "25" } }])(
		"rejects missing or malformed primary quota: %j",
		async (body) => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
			await expect(fetchAccountUsage("anthropic", "fixture")).rejects.toThrow("no primary limit");
		},
	);

	it("does not report invalid reset timestamps", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ five_hour: { utilization: 10, resets_at: "invalid" } })),
		);
		await expect(fetchAccountUsage("anthropic", "fixture")).resolves.toEqual({ remaining: 90 });
	});

	it("reports HTTP status without exposing response bodies", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private response", { status: 401 })));
		await expect(fetchAccountUsage("anthropic", "fixture")).rejects.toThrow("Account quota HTTP 401");
	});

	it("reports invalid JSON", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
		await expect(fetchAccountUsage("anthropic", "fixture")).rejects.toThrow("Invalid account quota response");
	});

	it("does not retry directly or expose transport errors", async () => {
		const request = vi.fn().mockRejectedValue(new Error("private proxy details"));
		vi.stubGlobal("fetch", request);
		await expect(fetchAccountUsage("anthropic", "fixture")).rejects.toThrow("check the connection and proxy");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("renders the ASCII bar, UTC reset and remaining time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-29T03:30:00Z"));
		expect(formatAccountUsage({ remaining: 75, resetsAt: Date.parse("2026-10-29T06:00:00Z") })).toBe(
			"Usage [:::::::::::::::     ] left 75%\nResets: 2026-10-29 06:00 UTC in 2h 30m",
		);
		expect(formatAccountUsage({ remaining: 0 })).toBe("Usage [                    ] left 0%\nResets: unknown");
		expect(formatAccountUsage({ remaining: 100, resetsAt: Date.parse("2026-10-29T03:00:00Z") })).toContain(
			"in 0h 0m",
		);
	});
});
