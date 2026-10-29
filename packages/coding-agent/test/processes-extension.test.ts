import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import processesExtension from "../src/extensions/processes/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let directory: string;
const runners: ExtensionRunner[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-process-extension-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.emit({ type: "session_shutdown", reason: "quit" });
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const runtime = createExtensionRuntime();
	const sendMessage = vi.fn();
	runtime.sendMessage = sendMessage;
	const extension = await loadExtensionFromFactory(
		processesExtension,
		directory,
		createEventBus(),
		runtime,
		"builtin:processes",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner([extension], runtime, directory, SessionManager.inMemory(directory), registry);
	runners.push(runner);
	return { extension, runner, sendMessage, tool: extension.tools.get("process")!.definition };
}

describe("process tool", () => {
	it("registers /ps and uses a provider-compatible object schema", async () => {
		const fixture = await setup();
		expect(fixture.extension.commands.has("ps")).toBe(true);
		expect(fixture.tool.parameters).toMatchObject({ type: "object" });
	});

	it("reports successful completion as context without waking the agent", async () => {
		const fixture = await setup();
		const result = await fixture.tool.execute(
			"start",
			{ action: "start", name: "fixture", command: "printf output" },
			undefined,
			undefined,
			fixture.runner.createToolContext("start", undefined),
		);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("logPath") });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(fixture.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "process-exit" }), {
			triggerTurn: false,
			deliverAs: "followUp",
		});
	});

	it("wakes the agent on failure even when successful notifications are disabled", async () => {
		const fixture = await setup();
		await fixture.tool.execute(
			"start",
			{ action: "start", name: "fixture", command: "exit 7", onSuccess: "ignore" },
			undefined,
			undefined,
			fixture.runner.createToolContext("start", undefined),
		);
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(fixture.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining('"code":7') }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it.each([
		[{ action: "start" }, "name and command"],
		[{ action: "output" }, "requires id"],
		[{ action: "write" }, "requires id"],
		[{ action: "stop" }, "requires id"],
	])("rejects missing action-specific fields: %j", async (params, message) => {
		const fixture = await setup();
		await expect(
			fixture.tool.execute(
				"fixture",
				params,
				undefined,
				undefined,
				fixture.runner.createToolContext("fixture", undefined),
			),
		).rejects.toThrow(message);
	});
});
