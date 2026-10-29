// uses the pinned native AST engine against temporary source trees, never installed owencfg tools.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAstGrepPath } from "../src/config.ts";
import { applyAstMatches, searchAst } from "../src/extensions/code/ast.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-ast-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("AST search and replacement", () => {
	it("resolves the pinned native engine, not PATH", () => expect(getAstGrepPath()).toContain("@ast-grep/cli-linux-"));
	it("matches calls structurally without matching strings or comments", async () => {
		writeFileSync(join(directory, "fixture.ts"), 'foo(1);\nconst text = "foo(2)";\n// foo(3)\nfoo(4);\n');
		const matches = await searchAst({ pattern: "foo($ARG)", lang: "typescript", paths: ["fixture.ts"] }, directory);
		expect(matches.map((match) => match.text)).toEqual(["foo(1)", "foo(4)"]);
	});
	it("previews edits without writing and applies Unicode-safe byte ranges atomically", async () => {
		const path = join(directory, "fixture.ts");
		writeFileSync(path, 'const title = "привет"; foo(1); foo(2);\n', { mode: 0o640 });
		const matches = await searchAst(
			{ pattern: "foo($ARG)", rewrite: "bar($ARG)", lang: "typescript", paths: [path] },
			directory,
		);
		expect(readFileSync(path, "utf8")).toContain("foo(1)");
		expect(matches.map((match) => match.replacement)).toEqual(["bar(1)", "bar(2)"]);
		await applyAstMatches(matches, directory);
		expect(readFileSync(path, "utf8")).toBe('const title = "привет"; bar(1); bar(2);\n');
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(readdirSync(directory)).toEqual(["fixture.ts"]);
	});
	it.each([
		["c", "fixture.c", "int main(void) { foo(1); }", "foo($ARG);"],
		["go", "fixture.go", "package main\nfunc main() { foo(1) }"],
		["rust", "fixture.rs", "fn main() { foo(1); }"],
		["python", "fixture.py", "foo(1)\n"],
		["zig", "fixture.zig", "pub fn main() void { foo(1); }"],
	])("supports %s syntax", async (lang, filename, content, pattern = "foo($ARG)") => {
		writeFileSync(join(directory, filename), content);
		expect(await searchAst({ pattern, lang, paths: [filename] }, directory)).toHaveLength(1);
	});
	it("refuses stale matches and preserves the newer file", async () => {
		const path = join(directory, "stale.ts");
		writeFileSync(path, "foo(1);\n");
		const matches = await searchAst(
			{ pattern: "foo($ARG)", rewrite: "bar($ARG)", lang: "typescript", paths: [path] },
			directory,
		);
		writeFileSync(path, "foo(2);\n");
		await expect(applyAstMatches(matches, directory)).rejects.toThrow("stale");
		expect(readFileSync(path, "utf8")).toBe("foo(2);\n");
	});
	it("rejects overlapping edits instead of duplicating text", async () => {
		writeFileSync(join(directory, "overlap.ts"), "foo(1);");
		const matches = await searchAst(
			{ pattern: "foo($ARG)", rewrite: "bar($ARG)", lang: "typescript", paths: ["overlap.ts"] },
			directory,
		);
		await expect(applyAstMatches([...matches, ...matches], directory)).rejects.toThrow("overlap");
	});
	it("reports an invalid pattern and forbids root traversal", async () => {
		await expect(searchAst({ pattern: "", lang: "typescript", paths: [directory] }, directory)).rejects.toThrow(
			"AST pattern",
		);
		await expect(searchAst({ pattern: "foo()", lang: "typescript", paths: ["/"] }, directory)).rejects.toThrow(
			"cannot start from /",
		);
	});
	it("honors cancellation before invoking the engine", async () => {
		await expect(
			searchAst(
				{
					pattern: "foo()",
					lang: "typescript",
					paths: [directory],
					signal: AbortSignal.abort(new Error("cancelled")),
				},
				directory,
			),
		).rejects.toThrow("cancelled");
	});
});
