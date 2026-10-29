import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBundledSkillsPath } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { readBrowserMode } from "../src/core/browser-settings.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { readProfile, writeProfile } from "../src/core/profile.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { normalizeBuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import profileExtension from "../src/extensions/profile/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-profile-extension-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		profileExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"builtin:profile",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), registry);
	const input = vi.fn<(...args: unknown[]) => Promise<string | undefined>>();
	const notify = vi.fn();
	const select = vi.fn<(...args: unknown[]) => Promise<string | undefined>>().mockResolvedValue("headless");
	runner.setUIContext({ ...runner.createContext().ui, input, notify, select }, "tui");
	return { extension, runner, input, notify, select };
}

describe("identity setup", () => {
	it("loads bundled skills without depending on an installed owencfg checkout", async () => {
		const fixture = await setup();
		expect(fixture.extension.handlers.has("resources_discover")).toBe(true);
		const loaded = loadSkillsFromDir({ dir: getBundledSkillsPath(), source: "builtin" });
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.skills.map((skill) => skill.name).sort()).toEqual([
			"attached-repositories",
			"commit",
			"humanizer",
			"init",
			"learn-from-feedback",
		]);
	});

	it("asks first-run identity questions and saves optional nonempty fields", async () => {
		const fixture = await setup();
		for (const value of ["fixture", "example.org", "", "github.com/example", ""])
			fixture.input.mockResolvedValueOnce(value);
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(fixture.input).toHaveBeenCalledTimes(5);
		expect(readProfile()).toEqual({ name: "fixture", website: "example.org", github: "github.com/example" });
		expect(readBrowserMode()).toBe("headless");
		expect(fixture.select).toHaveBeenCalledTimes(1);
		await fixture.runner.emit({ type: "session_start", reason: "reload" });
		expect(fixture.input).toHaveBeenCalledTimes(5);
	});

	it("leaves setup retryable after browser mode cancellation", async () => {
		const fixture = await setup();
		for (const value of ["fixture", "", "", "", ""]) fixture.input.mockResolvedValueOnce(value);
		fixture.select.mockResolvedValueOnce(undefined);
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(readProfile()).toBeUndefined();
		expect(readBrowserMode()).toBeUndefined();
	});

	it("asks only for browser mode when identity is already configured", async () => {
		writeProfile({ name: "fixture" });
		const fixture = await setup();
		fixture.select.mockResolvedValueOnce("xvfb");
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(fixture.input).not.toHaveBeenCalled();
		expect(readBrowserMode()).toBe("xvfb");
	});

	it("does not save a partial profile after cancellation", async () => {
		const fixture = await setup();
		fixture.input.mockResolvedValueOnce("fixture").mockResolvedValueOnce(undefined);
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(readProfile()).toBeUndefined();
		expect(fixture.input).toHaveBeenCalledTimes(2);
	});

	it("requires a name and leaves setup retryable", async () => {
		const fixture = await setup();
		fixture.input.mockResolvedValueOnce(" ");
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(readProfile()).toBeUndefined();
		expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining("NAME is required"), "warning");
		expect(fixture.extension.commands.has("setup")).toBe(true);
	});

	it("does not open dialogs in a headless session", async () => {
		const fixture = await setup();
		fixture.runner.setUIContext();
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(fixture.input).not.toHaveBeenCalled();
	});

	it("does not request onboarding through an RPC client", async () => {
		const fixture = await setup();
		fixture.runner.setUIContext(
			{ ...fixture.runner.createContext().ui, input: fixture.input, select: fixture.select, notify: fixture.notify },
			"rpc",
		);
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(fixture.input).not.toHaveBeenCalled();
		expect(fixture.select).not.toHaveBeenCalled();
	});

	it("replaces only the default prompt and preserves an explicit user prompt", async () => {
		writeProfile({ name: "fixture" });
		const fixture = await setup();
		const handlers = fixture.extension.handlers.get("before_agent_start")!;
		for (const customPrompt of [undefined, "explicit user instructions"]) {
			const systemPromptOptions = normalizeBuildSystemPromptOptions({ cwd: process.cwd(), customPrompt });
			for (const handler of handlers)
				await handler(
					{
						type: "before_agent_start",
						systemPrompt: "default",
						systemPromptOptions,
						source: "user",
						prompt: "hello",
						images: undefined,
					},
					fixture.runner.createContext(),
				);
			if (customPrompt) expect(systemPromptOptions.customPrompt).toBe(customPrompt);
			else expect(systemPromptOptions.customPrompt).toContain("you are the AI agent of fixture.");
		}
	});
});
