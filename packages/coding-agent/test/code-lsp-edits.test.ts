// validates LSP workspace edits and stale-file protection with temporary files.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyLspEdits, planLspEdits } from "../src/extensions/code/lsp-edits.ts";

let directory: string;
let path: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-lsp-edits-"));
	path = join(directory, "fixture.ts");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("LSP workspace text edits", () => {
	it("applies UTF-16 ranges across multiple edits", async () => {
		writeFileSync(path, "привет foo\nbar\n");
		const plans = await planLspEdits({
			changes: {
				[pathToFileURL(path).href]: [
					{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } }, newText: "one" },
					{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: "two" },
				],
			},
		});
		expect(await applyLspEdits(plans)).toEqual([path]);
		expect(readFileSync(path, "utf8")).toBe("привет one\ntwo\n");
	});
	it("rejects edits if a file changed after preview", async () => {
		writeFileSync(path, "old");
		const plans = await planLspEdits({
			changes: {
				[pathToFileURL(path).href]: [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "new" },
				],
			},
		});
		writeFileSync(path, "other");
		await expect(applyLspEdits(plans)).rejects.toThrow("changed since");
		expect(readFileSync(path, "utf8")).toBe("other");
	});
	it("rejects file creation/deletion and overlapping ranges", async () => {
		writeFileSync(path, "fixture");
		await expect(
			planLspEdits({ documentChanges: [{ kind: "delete", uri: pathToFileURL(path).href }] }),
		).rejects.toThrow("resource operations");
		const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "x" };
		await expect(planLspEdits({ changes: { [pathToFileURL(path).href]: [edit, edit] } })).rejects.toThrow("overlap");
	});
});
