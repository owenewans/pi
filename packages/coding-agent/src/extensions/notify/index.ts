// sends Linux desktop notifications when an interactive agent run settles.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

export default function notifyExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let running = false;
	let startedAt = 0;
	let warned = false;
	pi.registerCommand("notify", {
		description: "Configure desktop completion notifications: on, off or status",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (!action) enabled = !enabled;
			else if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action !== "status") {
				ctx.ui.notify("Usage: /notify [on|off|status]", "warning");
				return;
			}
			ctx.ui.notify(`Desktop notifications ${enabled ? "on" : "off"}`, "info");
		},
	});
	pi.on("agent_start", () => {
		running = true;
		startedAt = Date.now();
	});
	pi.on("agent_settled", async (event, ctx) => {
		if (!running) return;
		running = false;
		if (!enabled || event.aborted || ctx.mode !== "tui") return;
		const label = ctx.sessionManager.getSessionName() || basename(ctx.cwd);
		const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
		try {
			await notifyDesktop(`${label}: finished in ${seconds}s`);
		} catch {
			if (!warned) {
				warned = true;
				ctx.ui.notify(
					"Desktop notifications unavailable; install notify-send and run a notification daemon",
					"warning",
				);
			}
		}
	});
}

/** Sends plain completion metadata without including prompts or model output. */
export function notifyDesktop(body: string): Promise<void> {
	const plain = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return new Promise((resolve, reject) => {
		execFile(
			"notify-send",
			["--app-name=pi", "--", "pi finished", plain],
			{ timeout: 5000, windowsHide: true },
			(error) => {
				if (error) reject(new Error("Desktop notification failed"));
				else resolve();
			},
		);
	});
}
