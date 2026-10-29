// displays account quota from Claude and ChatGPT OAuth APIs.
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { fetchService } from "../../core/http-dispatcher.ts";

export type UsageProvider = "anthropic" | "openai-codex";

export type AccountUsage = {
	remaining: number;
	resetsAt?: number;
};

export default function usageExtension(pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show Claude or ChatGPT account quota",
		handler: async (args, ctx) => {
			const selected = args.trim() || ctx.model?.provider || "openai-codex";
			let provider = selected;
			if (selected === "openai" || selected === "chatgpt") provider = "openai-codex";
			else if (selected === "claude") provider = "anthropic";
			if (provider !== "anthropic" && provider !== "openai-codex") {
				ctx.ui.notify(`Account quota unavailable for ${provider}`, "warning");
				return;
			}
			const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider);
			if (!model || !ctx.modelRegistry.isUsingOAuth(model)) {
				ctx.ui.notify(`Log in to ${provider} with /login first`, "warning");
				return;
			}
			const token = await ctx.modelRegistry.getApiKeyForProvider(provider);
			if (!token) {
				ctx.ui.notify(`No OAuth token for ${provider}; use /login`, "error");
				return;
			}
			try {
				const usage = await fetchAccountUsage(provider, token);
				ctx.ui.notify(formatAccountUsage(usage), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Account quota request failed", "error");
			}
		},
	});
}

/** Fetches the primary account quota without sending inference requests. */
export async function fetchAccountUsage(provider: UsageProvider, token: string): Promise<AccountUsage> {
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
		response = await fetchService("usage", url, { headers, signal: AbortSignal.timeout(15_000) });
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
	const window =
		provider === "anthropic" ? record(payload?.five_hour) : record(record(payload?.rate_limit)?.primary_window);
	const used = provider === "anthropic" ? window?.utilization : window?.used_percent;
	if (typeof used !== "number" || !Number.isFinite(used))
		throw new Error("Account quota response has no primary limit");
	const reset = provider === "anthropic" ? window?.resets_at : window?.reset_at;
	let resetsAt: number | undefined;
	if (typeof reset === "string") resetsAt = Date.parse(reset);
	else if (typeof reset === "number") resetsAt = reset * 1000;
	const usage: AccountUsage = { remaining: Math.max(0, Math.min(100, 100 - used)) };
	if (resetsAt !== undefined && Number.isFinite(resetsAt)) usage.resetsAt = resetsAt;
	return usage;
}

// quota payloads and decoded JWT claims cross a network-input boundary.
function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Renders the primary quota using owencfg's compact ASCII bar. */
export function formatAccountUsage(usage: AccountUsage): string {
	const blocks = Math.round(usage.remaining / 5);
	const bar = `Usage [${":".repeat(blocks)}${" ".repeat(20 - blocks)}] left ${usage.remaining.toFixed(0)}%`;
	if (usage.resetsAt === undefined) return `${bar}\nResets: unknown`;
	const minutes = Math.max(0, Math.floor((usage.resetsAt - Date.now()) / 60_000));
	const reset = new Date(usage.resetsAt).toISOString().replace("T", " ").slice(0, 16);
	return `${bar}\nResets: ${reset} UTC in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
