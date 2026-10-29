// configures the agent's identity at first launch and through /setup.

import { getBundledSkillsPath } from "../../config.ts";
import { readBrowserMode, writeBrowserMode } from "../../core/browser-settings.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { type AgentProfile, readProfile, renderProfilePrompt, writeProfile } from "../../core/profile.ts";

export default function profileExtension(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({ skillPaths: [getBundledSkillsPath()] }));
	let profile = readProfile();
	let settingUp = false;
	const setupBrowserMode = async (ctx: ExtensionContext): Promise<boolean> => {
		const mode = await ctx.ui.select("Browser mode", ["headless", "headed", "xvfb"]);
		if (mode === undefined) return false;
		if (mode !== "headless" && mode !== "headed" && mode !== "xvfb")
			throw new Error("Invalid browser mode selection");
		writeBrowserMode(mode);
		return true;
	};
	const setup = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) throw new Error("Run /setup in interactive mode to configure identity");
		if (settingUp) return;
		settingUp = true;
		try {
			const next: AgentProfile = { name: "" };
			for (const [key, label] of [
				["name", "NAME"],
				["website", "WEB (optional)"],
				["email", "EMAIL (optional)"],
				["github", "GITHUB (optional)"],
				["codeberg", "CODEBERG (optional)"],
			] as const) {
				const answer = await ctx.ui.input(label, profile?.[key]);
				if (answer === undefined) return;
				const value = answer.trim();
				if (key === "name" && !value) {
					ctx.ui.notify("NAME is required; use /setup to try again", "warning");
					return;
				}
				if (value) next[key] = value;
			}
			if (!(await setupBrowserMode(ctx))) return;
			writeProfile(next);
			profile = next;
			ctx.ui.notify("Identity saved", "info");
		} finally {
			settingUp = false;
		}
	};
	pi.registerCommand("setup", { description: "Configure agent identity", handler: async (_args, ctx) => setup(ctx) });
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!profile) await setup(ctx);
		else if (!readBrowserMode()) await setupBrowserMode(ctx);
	});
	pi.on("before_agent_start", (event) => {
		// explicit user SYSTEM.md remains authoritative over the bundled default.
		if (profile && !event.systemPromptOptions.customPrompt)
			event.systemPromptOptions.customPrompt = renderProfilePrompt(profile);
	});
}
