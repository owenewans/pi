// checks Zed extension lifecycle and registration without an editor process.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import zedExtension from "../src/extensions/zed/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("registers editor tools and starts and stops without a Zed database", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-zed-extension-"));
	directories.push(cwd);
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(zedExtension, cwd, createEventBus(), runtime, "builtin:zed");
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), registry);
	expect([...extension.tools.keys()]).toEqual(["zed_current_context", "zed_open_files", "zed_selected_lines"]);
	await runner.emit({ type: "session_start", reason: "startup" });
	await runner.emit({ type: "session_shutdown", reason: "quit" });
});
