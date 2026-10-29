// checks the browser dispatcher without starting an external browser.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { readBrowserMode } from "../src/core/browser-settings.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import browserExtension from "../src/extensions/browser/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let directory: string;
const runners: ExtensionRunner[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-browser-extension-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.emit({ type: "session_shutdown", reason: "quit" });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		browserExtension,
		directory,
		createEventBus(),
		runtime,
		"builtin:browser",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner([extension], runtime, directory, SessionManager.inMemory(directory), registry);
	runners.push(runner);
	const tool = extension.tools.get("browser")!.definition;
	return {
		runner,
		extension,
		call: (
			params: { action: "list" | "call"; tool?: string; args?: Record<string, unknown> },
			signal?: AbortSignal,
		) => tool.execute("fixture", params, signal, undefined, runner.createToolContext("fixture", undefined)),
	};
}

describe("browser dispatcher", () => {
	it("lists the complete Playwright catalog and mode control without launching Camoufox", async () => {
		const launch = vi.spyOn(firefox, "launchPersistentContext");
		const fixture = await setup();
		const result = await fixture.call({ action: "list" });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("browser_navigate") });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("browser_set_mode") });
		expect(launch).not.toHaveBeenCalled();
		expect(fixture.extension.commands.has("browser")).toBe(true);
	});
	it("persists mode without launching a browser and rejects invalid modes", async () => {
		const fixture = await setup();
		await fixture.call({ action: "call", tool: "browser_set_mode", args: { mode: "xvfb" } });
		expect(readBrowserMode()).toBe("xvfb");
		await expect(
			fixture.call({ action: "call", tool: "browser_set_mode", args: { mode: "invalid" } }),
		).rejects.toThrow("headed, headless or xvfb");
		expect(readBrowserMode()).toBe("xvfb");
	});
	it("handles cancelled queued requests without poisoning later calls", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(fixture.call({ action: "list" }, controller.signal)).rejects.toThrow("cancelled");
		await expect(
			fixture.call({ action: "call", tool: "browser_set_mode", args: { mode: "headless" } }),
		).resolves.toBeDefined();
	});
	it("reopens the dispatcher after a new session", async () => {
		const fixture = await setup();
		await fixture.call({ action: "list" });
		await fixture.runner.emit({ type: "session_shutdown", reason: "new" });
		await fixture.runner.emit({ type: "session_start", reason: "new" });
		await expect(fixture.call({ action: "list" })).resolves.toBeDefined();
	});
});
