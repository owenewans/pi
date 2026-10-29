// checks clangd integration with a disposable C file; no external service or account is used.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageServers } from "../src/extensions/code/lsp.ts";

const servers = new LanguageServers();
const directories: string[] = [];
afterEach(async () => {
	await servers.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!servers.supports("fixture.c"))("clangd integration", () => {
	it("returns real diagnostics and clears them after synchronization", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-clangd-test-"));
		directories.push(directory);
		const path = join(directory, "fixture.c");
		writeFileSync(path, "int main(void) { return missing_symbol; }\n");
		const initial = await servers.diagnostics(path, directory);
		expect(initial.confirmed).toBe(true);
		expect(initial.diagnostics.some((item) => item.message.includes("missing_symbol"))).toBe(true);
		writeFileSync(path, "int main(void) { return 0; }\n");
		const fixed = await servers.diagnostics(path, directory);
		expect(fixed.confirmed).toBe(true);
		expect(fixed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
	}, 30_000);
});
