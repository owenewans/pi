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
		const request = vi.fn().mockResolvedValue(
			Response.json({
				five_hour: { utilization: 25, resets_at: "2026-10-29T06:00:00Z" },
			}),
		);
		vi.stubGlobal("fetch", request);
		await expect(fetchAccountUsage("anthropic", "fixture-token")).resolves.toEqual({
			remaining: 75,
			resetsAt: Date.parse("2026-10-29T06:00:00Z"),
		});
		expect(request).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: "Bearer fixture-token",
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: expect.any(AbortSignal),
		});
	});

	it("preserves ChatGPT's primary quota and scopes the account", async () => {
		const claims = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": {
					chatgpt_account_id: "fixture-account",
				},
			}),
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
		await expect(fetchAccountUsage("openai-codex", token)).resolves.toEqual({
			remaining: 40,
			resetsAt: 1_000_000,
		});
		expect(request).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", {
			headers: {
				Authorization: `Bearer ${token}`,
				"ChatGPT-Account-Id": "fixture-account",
			},
			signal: expect.any(AbortSignal),
		});
	});

	it("reads Claude weekly quota and labels the separate monthly extra spending cap", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					five_hour: { utilization: 25 },
					seven_day: { utilization: 60, resets_at: "2026-11-01T06:00:00Z" },
					extra_usage: {
						is_enabled: true,
						monthly_limit: 2000,
						used_credits: 500,
					},
				}),
			),
		);
		const usage = await fetchAccountUsage("anthropic", "fixture");
		expect(usage).toEqual({
			remaining: 75,
			weekly: { remaining: 40, resetsAt: Date.parse("2026-11-01T06:00:00Z") },
			monthly: { remaining: 75 },
			monthlyKind: "extra",
		});
		expect(formatAccountUsage(usage)).toContain("Monthly extra [:::::::::::::::     ] left 75%\nResets: unknown");
	});

	it.each([
		[604800, 2592000],
		[2592000, 604800],
		[604800, 2419200],
		[604800, 2678400],
	])("classifies ChatGPT primary/secondary durations %s/%s", async (primarySeconds, secondarySeconds) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					rate_limit: {
						primary_window: {
							used_percent: 20,
							reset_at: 1000,
							limit_window_seconds: primarySeconds,
						},
						secondary_window: {
							used_percent: 70,
							reset_at: 2000,
							limit_window_seconds: secondarySeconds,
						},
					},
				}),
			),
		);
		expect(await fetchAccountUsage("openai-codex", "fixture")).toEqual({
			remaining: 80,
			resetsAt: 1_000_000,
			weekly: {
				remaining: primarySeconds === 604800 ? 80 : 30,
				resetsAt: primarySeconds === 604800 ? 1_000_000 : 2_000_000,
			},
			monthly: {
				remaining: primarySeconds === 604800 ? 30 : 80,
				resetsAt: primarySeconds === 604800 ? 2_000_000 : 1_000_000,
			},
		});
	});

	it("reads ChatGPT weekly reset_after_seconds without inventing a monthly quota", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					rate_limit: {
						primary_window: { used_percent: 10, limit_window_seconds: 18000 },
						secondary_window: {
							used_percent: 40,
							limit_window_seconds: 604800,
							reset_after_seconds: 3600,
						},
					},
				}),
			),
		);
		expect(await fetchAccountUsage("openai-codex", "fixture")).toEqual({
			remaining: 90,
			weekly: { remaining: 60, resetsAt: 4_600_000 },
		});
	});

	it.each([null, [], {}, { utilization: "30" }, { utilization: null }])(
		"ignores malformed Claude weekly quotas: %j",
		async (seven_day) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(Response.json({ five_hour: { utilization: 25 }, seven_day })),
			);
			expect(await fetchAccountUsage("anthropic", "fixture")).toEqual({
				remaining: 75,
			});
		},
	);

	it.each([
		null,
		{},
		{ is_enabled: false, monthly_limit: 100, used_credits: 20 },
		{ is_enabled: true, monthly_limit: null, used_credits: 20 },
		{ is_enabled: true, monthly_limit: 0, used_credits: 20 },
		{ is_enabled: true, monthly_limit: -100, used_credits: 20 },
		{ is_enabled: true, monthly_limit: "100", used_credits: 20 },
		{ is_enabled: true, monthly_limit: 100, used_credits: -20 },
		{ is_enabled: true, monthly_limit: 100 },
	])("does not fabricate a Claude monthly limit from %j", async (extra_usage) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ five_hour: { utilization: 25 }, extra_usage })));
		expect(await fetchAccountUsage("anthropic", "fixture")).toEqual({
			remaining: 75,
		});
	});

	it.each([
		null,
		[],
		{},
		{ used_percent: "20", limit_window_seconds: 604800 },
		{ used_percent: 20, limit_window_seconds: "604800" },
		{ used_percent: 20, limit_window_seconds: 18000 },
		{ used_percent: 20, limit_window_seconds: 31536000 },
	])("does not infer weekly or monthly ChatGPT limits from %j", async (secondary_window) => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					rate_limit: {
						primary_window: { used_percent: 25 },
						secondary_window,
					},
				}),
			),
		);
		expect(await fetchAccountUsage("openai-codex", "fixture")).toEqual({
			remaining: 75,
		});
	});

	it("still requires the primary quota even when secondary quotas exist", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					rate_limit: {
						secondary_window: {
							used_percent: 20,
							limit_window_seconds: 604800,
						},
					},
				}),
			),
		);
		await expect(fetchAccountUsage("openai-codex", "fixture")).rejects.toThrow("no primary limit");
	});

	it("accepts opaque tokens and clamps reported quota", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					rate_limit: { primary_window: { used_percent: 120 } },
				}),
			),
		);
		await expect(fetchAccountUsage("openai-codex", "opaque")).resolves.toEqual({
			remaining: 0,
		});
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
			vi.fn().mockResolvedValue(
				Response.json({
					five_hour: { utilization: 10, resets_at: "invalid" },
				}),
			),
		);
		await expect(fetchAccountUsage("anthropic", "fixture")).resolves.toEqual({
			remaining: 90,
		});
	});

	it("clamps secondary quotas and ignores invalid weekly reset timestamps", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					five_hour: { utilization: -10 },
					seven_day: { utilization: 120, resets_at: "invalid" },
					extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 200 },
				}),
			),
		);
		expect(await fetchAccountUsage("anthropic", "fixture")).toEqual({
			remaining: 100,
			weekly: { remaining: 0 },
			monthly: { remaining: 0 },
			monthlyKind: "extra",
		});
	});

	it("ignores out-of-range numeric reset timestamps", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(Response.json({ rate_limit: { primary_window: { used_percent: 10, reset_at: 1e30 } } })),
		);
		expect(await fetchAccountUsage("openai-codex", "fixture")).toEqual({ remaining: 90 });
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

	it("renders weekly and monthly ASCII bars with their own resets", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-29T03:30:00Z"));
		expect(
			formatAccountUsage({
				remaining: 75,
				weekly: { remaining: 50, resetsAt: Date.parse("2026-10-30T03:30:00Z") },
				monthly: { remaining: 0, resetsAt: Date.parse("2026-11-01T03:30:00Z") },
			}),
		).toBe(
			"Usage [:::::::::::::::     ] left 75%\nResets: unknown\nWeekly [::::::::::          ] left 50%\nResets: 2026-10-30 03:30 UTC in 24h 0m\nMonthly [                    ] left 0%\nResets: 2026-11-01 03:30 UTC in 72h 0m",
		);
	});

	it("renders the ASCII bar, UTC reset and remaining time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-29T03:30:00Z"));
		expect(
			formatAccountUsage({
				remaining: 75,
				resetsAt: Date.parse("2026-10-29T06:00:00Z"),
			}),
		).toBe(
			"Usage [:::::::::::::::     ] left 75%\nResets: 2026-10-29 06:00 UTC in 2h 30m\nWeekly: unavailable (not reported by API)\nMonthly: unavailable (not reported by API)",
		);
		expect(formatAccountUsage({ remaining: 0 })).toBe(
			"Usage [                    ] left 0%\nResets: unknown\nWeekly: unavailable (not reported by API)\nMonthly: unavailable (not reported by API)",
		);
		expect(
			formatAccountUsage({
				remaining: 100,
				resetsAt: Date.parse("2026-10-29T03:00:00Z"),
			}),
		).toContain("in 0h 0m");
	});
});
