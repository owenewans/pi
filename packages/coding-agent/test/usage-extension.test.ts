import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { fetchService } from "../src/core/http-dispatcher.ts";
import usageExtension, { fetchAccountUsage, formatAccountUsage } from "../src/extensions/usage/index.ts";

vi.mock("../src/core/http-dispatcher.ts", () => ({
	fetchService: vi.fn((_service: string, input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
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
		expect(extension.commands.get("usage")?.description).toBe("Show Claude, ChatGPT or Antigravity account quota");
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
		expect(formatAccountUsage(usage)).toContain("Monthly extra   75% left  ████████░░");
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
					extra_usage: {
						is_enabled: true,
						monthly_limit: 100,
						used_credits: 200,
					},
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
			vi.fn().mockResolvedValue(
				Response.json({
					rate_limit: {
						primary_window: { used_percent: 10, reset_at: 1e30 },
					},
				}),
			),
		);
		expect(await fetchAccountUsage("openai-codex", "fixture")).toEqual({
			remaining: 90,
		});
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
			"  Usage           75% left  ████████░░\n  Weekly          50% left  █████░░░░░  resets in 1d\n  Monthly          0% left  ░░░░░░░░░░  resets in 3d",
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
		).toBe("  Usage           75% left  ████████░░  resets in 2h 30m");
		expect(formatAccountUsage({ remaining: 0 })).toBe("  Usage            0% left  ░░░░░░░░░░");
		expect(
			formatAccountUsage({
				remaining: 100,
				resetsAt: Date.parse("2026-10-29T03:00:00Z"),
			}),
		).toContain("resets now");
	});
});

const antigravityKey = JSON.stringify({
	token: "private-token",
	projectId: "fixture-project",
});

function antigravityFetch(payloads: Record<string, unknown | Response | Error>) {
	const request = vi.fn(async (url: string) => {
		const method = url.split(":").at(-1) ?? "";
		const payload = payloads[method];
		if (payload instanceof Error) throw payload;
		return payload instanceof Response ? payload : Response.json(payload ?? {});
	});
	vi.stubGlobal("fetch", request);
	return request;
}

describe("Antigravity usage", () => {
	it("uses the service proxy, OAuth envelope and RPC bodies, not inference", async () => {
		antigravityFetch({
			fetchAvailableModels: {
				models: {
					"gemini-pro": {
						quotaInfo: {
							remainingFraction: 0.75,
							resetTime: "2026-10-29T06:00:00Z",
						},
					},
				},
			},
			retrieveUserQuotaSummary: {
				groups: [
					{
						displayName: "Shared",
						buckets: [{ displayName: "Requests", window: "5h", remainingFraction: 0.5 }],
					},
				],
			},
			loadCodeAssist: {
				paidTier: { name: "Google AI Pro" },
				currentTier: { name: "Free" },
			},
		});
		const usage = await fetchAccountUsage("antigravity", antigravityKey);
		expect(usage.groups).toEqual([
			{ label: "Shared / Requests (5h)", quota: { remaining: 50 } },
			{
				label: "gemini-pro",
				quota: { remaining: 75, resetsAt: Date.parse("2026-10-29T06:00:00Z") },
			},
		]);
		for (const [method, body] of [
			["fetchAvailableModels", { project: "fixture-project" }],
			["retrieveUserQuotaSummary", {}],
		] as const) {
			expect(fetchService).toHaveBeenCalledWith(
				"usage",
				`https://daily-cloudcode-pa.googleapis.com/v1internal:${method}`,
				{
					method: "POST",
					headers: {
						Authorization: "Bearer private-token",
						"Content-Type": "application/json",
						"User-Agent": expect.stringContaining("antigravity/cli/"),
					},
					body: JSON.stringify(body),
					signal: expect.any(AbortSignal),
				},
			);
		}
		const output = formatAccountUsage(usage);
		expect(output).toContain("Antigravity (Google AI Pro)");
		expect(output).toContain("Shared quota pools");
		expect(output).toContain("gemini-pro              75% left  ████████░░");
		expect(output).not.toMatch(/Weekly|Monthly|private-token|fixture-project/);
	});

	it("keeps free-tier model quotas when aggregate summary returns 403", async () => {
		antigravityFetch({
			fetchAvailableModels: {
				models: { claude: { quotaInfo: { remainingFraction: 0 } } },
			},
			retrieveUserQuotaSummary: new Response("private-token SUBSCRIPTION_REQUIRED", { status: 403 }),
			loadCodeAssist: { currentTier: { name: "Free" } },
		});
		const output = formatAccountUsage(await fetchAccountUsage("antigravity", antigravityKey));
		expect(output).toContain("claude             0% left  ░░░░░░░░░░");
		expect(output).toContain("Aggregate quota unavailable: Account quota HTTP 403");
		expect(output).toContain("Antigravity (Free)");
		expect(output).not.toContain("private-token");
	});

	it("keeps aggregate quotas when models and optional tier fail", async () => {
		antigravityFetch({
			fetchAvailableModels: new Error("private-token"),
			retrieveUserQuotaSummary: {
				groups: [{ buckets: [{ bucketId: "pool", remainingFraction: 0.2 }] }],
			},
			loadCodeAssist: new Response("private-token", { status: 401 }),
		});
		const output = formatAccountUsage(await fetchAccountUsage("antigravity", antigravityKey));
		expect(output).toContain("pool              20% left  ██░░░░░░░░");
		expect(output).toContain("Model quota unavailable");
		expect(output).not.toContain("private-token");
	});

	it.each([null, "0.8", undefined])(
		"does not invent quotas from missing or malformed fractions: %j",
		async (remainingFraction) => {
			antigravityFetch({
				fetchAvailableModels: {
					models: {
						unknown: { quotaInfo: { remainingFraction, resetTime: "invalid" } },
						missing: {},
						invalid: null,
					},
				},
				retrieveUserQuotaSummary: {
					groups: [{ buckets: [{ bucketId: "pool", remainingFraction }] }, { buckets: {} }, null],
				},
			});
			const output = formatAccountUsage(await fetchAccountUsage("antigravity", antigravityKey));
			expect(output).toContain("Quota: unavailable");
			expect(output).not.toMatch(/100%|Weekly|Monthly/);
		},
	);

	it("clamps fractions and validates resets", async () => {
		antigravityFetch({
			fetchAvailableModels: {
				models: {
					low: { quotaInfo: { remainingFraction: -1, resetTime: "invalid" } },
					high: { quotaInfo: { remainingFraction: 2, resetTime: 1e30 } },
				},
			},
		});
		expect((await fetchAccountUsage("antigravity", antigravityKey)).groups).toEqual([
			{ label: "high", quota: { remaining: 100 } },
			{ label: "low", quota: { remaining: 0 } },
		]);
	});

	it.each([null, [], { groups: {} }, { groups: [null, { buckets: null }] }])(
		"handles malformed summaries: %j",
		async (summary) => {
			antigravityFetch({
				fetchAvailableModels: { models: [] },
				retrieveUserQuotaSummary: summary,
			});
			expect(formatAccountUsage(await fetchAccountUsage("antigravity", antigravityKey))).toContain(
				"Quota: unavailable",
			);
		},
	);

	it.each(["opaque", "{}", '{"token":"private-token"}', '{"projectId":"project"}', "[]"])(
		"rejects malformed OAuth credentials before fetching: %s",
		async (key) => {
			const request = antigravityFetch({});
			await expect(fetchAccountUsage("antigravity", key)).rejects.toThrow(
				"Invalid Antigravity OAuth credentials; use /login",
			);
			expect(request).not.toHaveBeenCalled();
		},
	);

	it.each([
		[new Response("secret", { status: 401 }), "HTTP 401"],
		[new Response("not json"), "Invalid account quota response"],
		[new Error("private-token"), "check the connection and proxy"],
	])("reports sanitized errors if both quota endpoints fail", async (failure, message) => {
		antigravityFetch({
			fetchAvailableModels: failure,
			retrieveUserQuotaSummary: new Response("secret", { status: 403 }),
		});
		await expect(fetchAccountUsage("antigravity", antigravityKey)).rejects.toThrow(message);
	});

	it.each(["", "antigravity"])("dispatches current or explicit Antigravity provider: %j", async (args) => {
		antigravityFetch({
			fetchAvailableModels: {
				models: { gemini: { quotaInfo: { remainingFraction: 0.5 } } },
			},
		});
		const extension = await loadExtensionFromFactory(
			usageExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:usage",
		);
		const command = extension.commands.get("usage");
		if (!command) throw new Error("usage command missing");
		const notify = vi.fn();
		const getApiKeyForProvider = vi.fn().mockResolvedValue(antigravityKey);
		await command.handler(args, {
			model: { provider: args ? "anthropic" : "antigravity" },
			ui: { notify },
			modelRegistry: {
				getAll: () => [{ provider: "antigravity" }],
				isUsingOAuth: () => true,
				getApiKeyForProvider,
			},
		} as unknown as Parameters<typeof command.handler>[1]);
		expect(getApiKeyForProvider).toHaveBeenCalledWith("antigravity");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("gemini            50% left  █████░░░░░"), "info");
	});

	it.each([
		["claude", "anthropic"],
		["chatgpt", "openai-codex"],
		["openai", "openai-codex"],
	])("preserves provider alias %s", async (alias, provider) => {
		const request = vi.fn().mockResolvedValue(
			Response.json({
				five_hour: { utilization: 25 },
				rate_limit: { primary_window: { used_percent: 25 } },
			}),
		);
		vi.stubGlobal("fetch", request);
		const extension = await loadExtensionFromFactory(
			usageExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:usage",
		);
		const command = extension.commands.get("usage");
		if (!command) throw new Error("usage command missing");
		const notify = vi.fn();
		const getApiKeyForProvider = vi.fn().mockResolvedValue("fixture");
		await command.handler(alias, {
			ui: { notify },
			modelRegistry: {
				getAll: () => [{ provider }],
				isUsingOAuth: () => true,
				getApiKeyForProvider,
			},
		} as unknown as Parameters<typeof command.handler>[1]);
		expect(getApiKeyForProvider).toHaveBeenCalledWith(provider);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage           75% left  ████████░░"), "info");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each(["not-oauth", "missing", "error"])("handles command auth failure: %s", async (state) => {
		const request = antigravityFetch({});
		const extension = await loadExtensionFromFactory(
			usageExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:usage",
		);
		const command = extension.commands.get("usage");
		if (!command) throw new Error("usage command missing");
		const notify = vi.fn();
		await command.handler("antigravity", {
			ui: { notify },
			modelRegistry: {
				getAll: () => [{ provider: "antigravity" }],
				isUsingOAuth: () => state !== "not-oauth",
				getApiKeyForProvider: async () => {
					if (state === "error") throw new Error("private-token");
					return undefined;
				},
			},
		} as unknown as Parameters<typeof command.handler>[1]);
		expect(request).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("/login"),
			state === "not-oauth" ? "warning" : "error",
		);
		expect(JSON.stringify(notify.mock.calls)).not.toContain("private-token");
	});
});
