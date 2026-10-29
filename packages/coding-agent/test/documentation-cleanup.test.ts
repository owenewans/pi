import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type VersionContext = {
	session: { state: { messages: unknown[] } };
	settingsManager: SettingsManager;
	reportInstallTelemetry(version: string): void;
};

const prototype = InteractiveMode.prototype as unknown as {
	recordInstalledVersion(this: VersionContext): void;
};

describe("documentation cleanup", () => {
	it("omits /changelog from built-in commands", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "changelog")).toBe(false);
		expect("handleChangelogCommand" in InteractiveMode.prototype).toBe(false);
	});

	it("keeps dedicated docs and examples without referring to the deleted README", () => {
		const prompt = buildSystemPrompt({ cwd: "/tmp/project" });
		expect(prompt).toContain("Additional docs:");
		expect(prompt).toContain("Examples:");
		expect(prompt).not.toContain("README.md");
	});

	it("records the installed version independently of changelog files", () => {
		const settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
		const reportInstallTelemetry = vi.fn();
		const context: VersionContext = { session: { state: { messages: [] } }, settingsManager, reportInstallTelemetry };
		prototype.recordInstalledVersion.call(context);
		expect(settingsManager.getLastChangelogVersion()).toBe(VERSION);
		expect(reportInstallTelemetry).toHaveBeenCalledWith(VERSION);
		prototype.recordInstalledVersion.call(context);
		expect(reportInstallTelemetry).toHaveBeenCalledTimes(1);
	});

	it("does not send an install ping while resuming a conversation", () => {
		const reportInstallTelemetry = vi.fn();
		const context: VersionContext = {
			session: { state: { messages: [{ role: "user", content: "fixture" }] } },
			settingsManager: SettingsManager.fromStorage(new InMemorySettingsStorage()),
			reportInstallTelemetry,
		};
		prototype.recordInstalledVersion.call(context);
		expect(reportInstallTelemetry).not.toHaveBeenCalled();
	});
});
