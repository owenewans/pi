// displays account quota from provider OAuth APIs.
import { antigravityEndpoint, antigravityHeaders } from "@earendil-works/pi-ai/providers/antigravity-client";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { fetchService } from "../../core/http-dispatcher.ts";

export type UsageProvider = "anthropic" | "openai-codex" | "antigravity";

export type UsageQuota = {
	remaining: number;
	resetsAt?: number;
};

export type AccountUsage = UsageQuota & {
	weekly?: UsageQuota;
	monthly?: UsageQuota;
	monthlyKind?: "extra";
};

export default function usageExtension(pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show Claude, ChatGPT or Antigravity account quota",
		handler: async (args, ctx) => {
			const selected = args.trim() || ctx.model?.provider || "openai-codex";
			let provider = selected;
			if (selected === "openai" || selected === "chatgpt") provider = "openai-codex";
			else if (selected === "claude") provider = "anthropic";
			if (provider !== "anthropic" && provider !== "openai-codex" && provider !== "antigravity") {
				ctx.ui.notify(`Account quota unavailable for ${provider}`, "warning");
				return;
			}
			const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider);
			if (!model || !ctx.modelRegistry.isUsingOAuth(model)) {
				ctx.ui.notify(`Log in to ${provider} with /login first`, "warning");
				return;
			}
			try {
				let token: string | undefined;
				try {
					token = await ctx.modelRegistry.getApiKeyForProvider(provider);
				} catch {
					throw new Error(`Unable to read OAuth token for ${provider}; use /login`);
				}
				if (!token) {
					ctx.ui.notify(`No OAuth token for ${provider}; use /login`, "error");
					return;
				}
				const usage = await fetchAccountUsage(provider, token);
				ctx.ui.notify(formatAccountUsage(usage), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Account quota request failed", "error");
			}
		},
	});
}

/** Fetches account quotas without sending inference requests. */
export function fetchAccountUsage(provider: "antigravity", token: string): Promise<AntigravityUsage>;
export function fetchAccountUsage(provider: "anthropic" | "openai-codex", token: string): Promise<AccountUsage>;
export function fetchAccountUsage(provider: UsageProvider, token: string): Promise<AccountUsage | AntigravityUsage>;
export async function fetchAccountUsage(
	provider: UsageProvider,
	token: string,
): Promise<AccountUsage | AntigravityUsage> {
	if (provider === "antigravity") return fetchAntigravityUsage(token);
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (provider === "anthropic") headers["anthropic-beta"] = "oauth-2025-04-20";
	else {
		// account IDs scope ChatGPT subscriptions; opaque tokens may omit this claim.
		try {
			const [, payload = ""] = token.split(".");
			const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
			const auth = record(record(claims)?.["https://api.openai.com/auth"]);
			if (typeof auth?.chatgpt_account_id === "string") headers["ChatGPT-Account-Id"] = auth.chatgpt_account_id;
		} catch {
			// the usage endpoint also accepts opaque tokens.
		}
	}
	const url =
		provider === "anthropic"
			? "https://api.anthropic.com/api/oauth/usage"
			: "https://chatgpt.com/backend-api/wham/usage";
	let response: Awaited<ReturnType<typeof fetchService>>;
	try {
		response = await fetchService("usage", url, {
			headers,
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new Error("Account quota request failed; check the connection and proxy");
	}
	if (!response.ok) throw new Error(`Account quota HTTP ${response.status}`);
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("Invalid account quota response");
	}
	const payload = record(body);
	const limits = record(payload?.rate_limit);
	const primary = provider === "anthropic" ? record(payload?.five_hour) : record(limits?.primary_window);
	const usage: AccountUsage | undefined = parseQuota(primary, provider);
	if (!usage) throw new Error("Account quota response has no primary limit");
	if (provider === "anthropic") {
		const weekly = parseQuota(record(payload?.seven_day), provider);
		if (weekly) usage.weekly = weekly;
		// extra usage is a separate monthly spending cap, not the subscription quota.
		const extra = record(payload?.extra_usage);
		const limit = extra?.monthly_limit;
		const used = extra?.used_credits;
		if (extra?.is_enabled === true && finite(limit) && limit > 0 && finite(used) && used >= 0) {
			usage.monthly = {
				remaining: Math.max(0, Math.min(100, 100 - (used / limit) * 100)),
			};
			usage.monthlyKind = "extra";
		}
	} else {
		for (const value of [limits?.primary_window, limits?.secondary_window]) {
			const window = record(value);
			const quota = parseQuota(window, provider);
			if (!quota) continue;
			const seconds = window?.limit_window_seconds;
			if (seconds === 604800) usage.weekly ??= quota;
			// month-length windows vary; do not classify arbitrary long limits as monthly.
			else if (finite(seconds) && seconds >= 28 * 86400 && seconds <= 31 * 86400) usage.monthly ??= quota;
		}
	}
	return usage;
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseQuota(window: Record<string, unknown> | undefined, provider: UsageProvider): UsageQuota | undefined {
	const used = provider === "anthropic" ? window?.utilization : window?.used_percent;
	if (!finite(used)) return undefined;
	const reset = provider === "anthropic" ? window?.resets_at : window?.reset_at;
	let resetsAt: number | undefined;
	if (typeof reset === "string") resetsAt = Date.parse(reset);
	else if (finite(reset)) resetsAt = reset * 1000;
	if (resetsAt === undefined && provider === "openai-codex" && finite(window?.reset_after_seconds)) {
		resetsAt = Date.now() + Math.max(0, window.reset_after_seconds) * 1000;
	}
	const quota: UsageQuota = {
		remaining: Math.max(0, Math.min(100, 100 - used)),
	};
	if (resetsAt !== undefined && Number.isFinite(resetsAt) && Math.abs(resetsAt) <= 8.64e15) quota.resetsAt = resetsAt;
	return quota;
}

// quota payloads and decoded JWT claims cross a network-input boundary.
function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Renders account quotas using owencfg's compact ASCII bar. */
export function formatAccountUsage(usage: AccountUsage | AntigravityUsage): string {
	if ("groups" in usage) {
		return [
			usage.plan ? `Antigravity (${usage.plan})` : "Antigravity",
			"Shared quota pools; model quotas are not independent budgets.",
			...usage.groups.map(({ label, quota }) => formatQuota(label, quota)),
			...usage.notes,
			...(usage.groups.length ? [] : ["Quota: unavailable (not reported by API)"]),
		].join("\n");
	}
	return [
		formatQuota("Usage", usage),
		formatQuota("Weekly", usage.weekly),
		formatQuota(usage.monthlyKind === "extra" ? "Monthly extra" : "Monthly", usage.monthly),
	].join("\n");
}

function formatQuota(label: string, quota: UsageQuota | undefined): string {
	if (!quota) return `${label}: unavailable (not reported by API)`;
	const blocks = Math.round(quota.remaining / 5);
	const bar = `${label} [${":".repeat(blocks)}${" ".repeat(20 - blocks)}] left ${quota.remaining.toFixed(0)}%`;
	if (quota.resetsAt === undefined) return `${bar}\nResets: unknown`;
	const minutes = Math.max(0, Math.floor((quota.resetsAt - Date.now()) / 60_000));
	const reset = new Date(quota.resetsAt).toISOString().replace("T", " ").slice(0, 16);
	return `${bar}\nResets: ${reset} UTC in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export type AntigravityUsage = {
	groups: { label: string; quota?: UsageQuota }[];
	notes: string[];
	plan?: string;
};

async function antigravityPost(method: string, token: string, body: Record<string, unknown>): Promise<unknown> {
	let response: Awaited<ReturnType<typeof fetchService>>;
	try {
		response = await fetchService("usage", `${antigravityEndpoint()}/v1internal:${method}`, {
			method: "POST",
			headers: antigravityHeaders(token),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new Error("Account quota request failed; check the connection and proxy");
	}
	if (!response.ok) throw new Error(`Account quota HTTP ${response.status}`);
	try {
		return await response.json();
	} catch {
		throw new Error("Invalid account quota response");
	}
}

function fractionQuota(value: Record<string, unknown> | undefined): UsageQuota | undefined {
	if (!finite(value?.remainingFraction)) return undefined;
	const quota: UsageQuota = {
		remaining: Math.max(0, Math.min(1, value.remainingFraction)) * 100,
	};
	const reset = typeof value.resetTime === "string" ? Date.parse(value.resetTime) : NaN;
	if (Number.isFinite(reset)) quota.resetsAt = reset;
	return quota;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

async function fetchAntigravityUsage(raw: string): Promise<AntigravityUsage> {
	let credentials: Record<string, unknown> | undefined;
	try {
		credentials = record(JSON.parse(raw));
	} catch {
		// credentials must be the OAuth JSON envelope, never a raw bearer token.
	}
	const token = text(credentials?.token);
	const project = text(credentials?.projectId);
	if (!token || !project) throw new Error("Invalid Antigravity OAuth credentials; use /login");
	const [models, summary, assist] = await Promise.allSettled([
		antigravityPost("fetchAvailableModels", token, { project }),
		antigravityPost("retrieveUserQuotaSummary", token, {}),
		antigravityPost("loadCodeAssist", token, {
			metadata: {
				ideType: "ANTIGRAVITY",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			},
		}),
	]);
	if (models.status === "rejected" && summary.status === "rejected") throw models.reason;
	const usage: AntigravityUsage = { groups: [], notes: [] };
	if (summary.status === "fulfilled") {
		const groups = record(summary.value)?.groups;
		for (const value of Array.isArray(groups) ? groups : []) {
			const group = record(value);
			const buckets = group?.buckets;
			for (const value of Array.isArray(buckets) ? buckets : []) {
				const bucket = record(value);
				if (!bucket) continue;
				const label = [text(group?.displayName), text(bucket.displayName) ?? text(bucket.bucketId) ?? "Quota"]
					.filter(Boolean)
					.join(" / ");
				const window = text(bucket.window);
				usage.groups.push({
					label: window ? `${label} (${window})` : label,
					quota: fractionQuota(bucket),
				});
			}
		}
	} else usage.notes.push(`Aggregate quota unavailable: ${summary.reason.message}`);
	if (models.status === "fulfilled") {
		const catalog = record(record(models.value)?.models);
		for (const [id, value] of Object.entries(catalog ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
			const model = record(value);
			if (!model || model.isInternal === true || id.startsWith("chat_")) continue;
			usage.groups.push({
				label: id,
				quota: fractionQuota(record(model.quotaInfo)),
			});
		}
	} else usage.notes.push(`Model quota unavailable: ${models.reason.message}`);
	if (assist.status === "fulfilled") {
		const payload = record(assist.value);
		for (const tier of [record(payload?.paidTier), record(payload?.currentTier)]) {
			usage.plan = text(tier?.name) ?? text(tier?.id);
			if (usage.plan) break;
		}
	}
	return usage;
}
