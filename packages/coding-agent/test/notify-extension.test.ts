import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import notifyExtension, { notifyDesktop } from "../src/extensions/notify/index.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-notify-"));
	vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH}`);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("desktop notifications", () => {
	it("registers /notify and waits for settlement instead of raw agent_end", async () => {
		const extension = await loadExtensionFromFactory(
			notifyExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:notify",
		);
		expect(extension.commands.has("notify")).toBe(true);
		expect(extension.handlers.has("agent_settled")).toBe(true);
		expect(extension.handlers.has("agent_end")).toBe(false);
	});

	it("passes arguments without shell evaluation and escapes notification markup", async () => {
		const output = join(directory, "args.json");
		writeFileSync(
			join(directory, "notify-send"),
			`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o700 },
		);
		await notifyDesktop("<project> & $(touch /tmp/not-a-command)");
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
			"--app-name=pi",
			"--",
			"pi finished",
			"&lt;project&gt; &amp; $(touch /tmp/not-a-command)",
		]);
	});

	it("reports command failures without exposing private stderr", async () => {
		writeFileSync(
			join(directory, "notify-send"),
			`#!${process.execPath}\nconsole.error('private details'); process.exit(1);\n`,
			{ mode: 0o700 },
		);
		await expect(notifyDesktop("fixture")).rejects.toThrow(/^Desktop notification failed$/);
	});
});
