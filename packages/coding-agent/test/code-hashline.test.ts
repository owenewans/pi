// checks hash-anchored UTF-8 edits without touching real user files.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editHashlines, readHashlines } from "../src/extensions/code/hashline.ts";

let directory: string;
let path: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-hashline-"));
	path = join(directory, "fixture.txt");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const anchor = (line: string) => line.slice(0, line.indexOf("|"));

describe("hashline edits", () => {
	it("reads bounded line numbers and hashes", async () => {
		writeFileSync(path, "alpha\nbeta\ngamma\n");
		const result = await readHashlines(path, directory, 2, 1);
		expect(result.content).toMatch(/^2:[a-f0-9]{8}\|beta$/);
		expect(result.totalLines).toBe(3);
		expect(result.nextLine).toBe(3);
	});
	it("replaces and inserts nonoverlapping lines while preserving CRLF and permissions", async () => {
		writeFileSync(path, "alpha\r\nbeta\r\ngamma\r\n", { mode: 0o640 });
		const lines = (await readHashlines(path, directory)).content.split("\n");
		await editHashlines(
			path,
			[
				{ op: "replace", start: anchor(lines[0]), lines: ["first", "second"] },
				{ op: "insert_after", anchor: anchor(lines[1]), lines: ["inserted"] },
			],
			directory,
		);
		expect(readFileSync(path, "utf8")).toBe("first\r\nsecond\r\nbeta\r\ninserted\r\ngamma\r\n");
		expect(statSync(path).mode & 0o777).toBe(0o640);
	});
	it("rejects stale anchors without changing the file", async () => {
		writeFileSync(path, "old\n");
		const read = await readHashlines(path, directory);
		writeFileSync(path, "new\n");
		await expect(
			editHashlines(path, [{ op: "replace", start: anchor(read.content), lines: ["replacement"] }], directory),
		).rejects.toThrow("Stale hashline");
		expect(readFileSync(path, "utf8")).toBe("new\n");
	});
	it("rejects overlapping edits and multiline array entries", async () => {
		writeFileSync(path, "a\nb\n");
		const lines = (await readHashlines(path, directory)).content.split("\n");
		await expect(
			editHashlines(
				path,
				[
					{ op: "replace", start: anchor(lines[0]), end: anchor(lines[1]), lines: [] },
					{ op: "insert_before", anchor: anchor(lines[1]), lines: ["x"] },
				],
				directory,
			),
		).rejects.toThrow("overlap");
		await expect(editHashlines(path, [{ op: "append", lines: ["bad\nline"] }], directory)).rejects.toThrow(
			"one line",
		);
	});
	it("preserves an unterminated final line", async () => {
		writeFileSync(path, "first\nlast");
		const lines = (await readHashlines(path, directory)).content.split("\n");
		await editHashlines(path, [{ op: "replace", start: anchor(lines[1]), lines: ["changed"] }], directory);
		expect(readFileSync(path, "utf8")).toBe("first\nchanged");
	});
	it("handles empty files and rejects binary or mixed line endings", async () => {
		writeFileSync(path, "");
		await editHashlines(path, [{ op: "append", lines: ["new"] }], directory);
		expect(readFileSync(path, "utf8")).toBe("new");
		writeFileSync(path, Buffer.from([0xff, 0]));
		await expect(readHashlines(path, directory)).rejects.toThrow("UTF-8");
		writeFileSync(path, "a\r\nb\n");
		await expect(readHashlines(path, directory)).rejects.toThrow("Mixed line endings");
	});
});
