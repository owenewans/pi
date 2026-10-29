import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageServers } from "../src/extensions/code/lsp.ts";

const fixture = fileURLToPath(new URL("./fixtures/code-lsp-server.mjs", import.meta.url));
let directory: string;
let path: string;
let servers: LanguageServers;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-lsp-test-"));
	path = join(directory, "fixture.c");
	writeFileSync(path, "broken\n");
	servers = new LanguageServers({ c: [process.execPath, fixture] });
});
afterEach(async () => {
	await servers.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("language-server workspaces", () => {
	it("opens a document and reports one-based push diagnostics", async () => {
		const result = await servers.diagnostics(path, directory);
		expect(result.confirmed).toBe(true);
		expect(result.diagnostics).toEqual([
			{
				path,
				line: 1,
				character: 1,
				severity: "error",
				message: "fixture diagnostic",
				code: "fixture-error",
				source: "fixture",
			},
		]);
	});
	it("synchronizes changed text with the old document's UTF-16 end position", async () => {
		writeFileSync(path, "broken\nline two\n");
		await servers.diagnostics(path, directory);
		writeFileSync(path, "fixed");
		expect(await servers.diagnostics(path, directory)).toEqual({ diagnostics: [], confirmed: true });
	});
	it("supports pull diagnostics", async () => {
		await servers.close();
		servers = new LanguageServers({ c: [process.execPath, fixture, "--pull"] });
		expect((await servers.diagnostics(path, directory)).diagnostics[0].message).toBe("fixture diagnostic");
	});
	it("converts one-based tool positions before hover and supports workspace requests", async () => {
		expect(await servers.request("textDocument/hover", path, directory, { line: 3, character: 7 })).toEqual({
			contents: { kind: "plaintext", value: "fixture hover 2:6" },
		});
		expect(await servers.workspaceRequest("workspace/symbol", path, directory, { query: "fixture" })).toEqual([
			{ name: "fixture", kind: 12 },
		]);
	});
	it("reports unsupported files without launching another process", async () => {
		await expect(servers.diagnostics(join(directory, "fixture.unknown"), directory)).rejects.toThrow(
			"No language server",
		);
	});
	it("rejects further operations after shutdown", async () => {
		await servers.close();
		await expect(servers.diagnostics(path, directory)).rejects.toThrow("owner is closed");
	});
});
