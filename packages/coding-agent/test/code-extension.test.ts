// verifies code tools and write diagnostics through the extension runner.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import codeExtension from "../src/extensions/code/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let directory: string;
let runner: ExtensionRunner;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-code-extension-"));
});
afterEach(async () => {
	await runner?.emit({ type: "session_shutdown", reason: "quit" });
	rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		codeExtension,
		directory,
		createEventBus(),
		runtime,
		"builtin:code",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	runner = new ExtensionRunner([extension], runtime, directory, SessionManager.inMemory(directory), registry);
	return extension;
}

describe("code extension", () => {
	it("registers provider-compatible tools and edits anchored files", async () => {
		const extension = await setup();
		expect([...extension.tools.keys()]).toEqual([
			"debugger",
			"ast_grep_search",
			"ast_grep_replace",
			"hashline_read",
			"hashline_edit",
			"lsp_navigation",
		]);
		for (const tool of extension.tools.values()) expect(tool.definition.parameters).toMatchObject({ type: "object" });
		const path = join(directory, "fixture.txt");
		writeFileSync(path, "before\n");
		const ctx = runner.createToolContext("fixture", undefined);
		const read = await extension.tools
			.get("hashline_read")!
			.definition.execute("fixture", { path }, undefined, undefined, ctx);
		const content = read.content[0];
		if (content.type !== "text") throw new Error("expected text");
		const parsed = JSON.parse(content.text) as { content: string };
		const anchor = parsed.content.split("|")[0];
		await extension.tools
			.get("hashline_edit")!
			.definition.execute(
				"fixture",
				{ path, edits: [{ op: "replace", start: anchor, lines: ["after"] }] },
				undefined,
				undefined,
				ctx,
			);
		expect(readFileSync(path, "utf8")).toBe("after\n");
	});
	it("refuses AST replacement on directories", async () => {
		const extension = await setup();
		await expect(
			extension.tools
				.get("ast_grep_replace")!
				.definition.execute(
					"fixture",
					{ path: directory, pattern: "foo()", rewrite: "bar()", lang: "typescript", apply: true },
					undefined,
					undefined,
					runner.createToolContext("fixture", undefined),
				),
		).rejects.toThrow("one regular file");
	});
});
