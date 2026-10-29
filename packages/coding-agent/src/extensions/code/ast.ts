// runs the pinned AST engine and publishes validated structural edits atomically.
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { getAstGrepPath } from "../../config.ts";
import { replaceFileContents } from "../../core/tools/atomic-edit.ts";

const matchSchema = Type.Object({
	text: Type.String(),
	file: Type.String(),
	language: Type.String(),
	range: Type.Object({
		byteOffset: Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }),
		start: Type.Object({ line: Type.Integer(), column: Type.Integer() }),
		end: Type.Object({ line: Type.Integer(), column: Type.Integer() }),
	}),
	replacement: Type.Optional(Type.String()),
	replacementOffsets: Type.Optional(
		Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }),
	),
});
export type AstMatch = Static<typeof matchSchema>;
export type AstSearch = { pattern: string; lang: string; paths: string[]; rewrite?: string; signal?: AbortSignal };

/** Search AST nodes with the pinned native engine, never a PATH-provided executable. */
export async function searchAst(options: AstSearch, cwd: string): Promise<AstMatch[]> {
	const paths = options.paths.length ? options.paths.map((path) => resolve(cwd, path)) : [cwd];
	if (paths.includes("/")) throw new Error("AST search cannot start from /");
	const args = [
		"run",
		"--pattern",
		options.pattern,
		"--lang",
		options.lang,
		"--json=compact",
		"--color=never",
		"--custom-languages=ignore",
		"--threads=2",
	];
	if (options.rewrite !== undefined) args.push("--rewrite", options.rewrite);
	args.push("--", ...paths);
	const text = await runAstGrep(args, cwd, options.signal);
	let result: unknown;
	try {
		result = JSON.parse(text);
	} catch {
		throw new Error("AST engine returned malformed JSON");
	}
	if (!Check(Type.Array(matchSchema), result)) throw new Error("AST engine returned invalid matches");
	return result;
}

/** Apply a preview's nonoverlapping byte edits, refusing stale ranges and changed files. */
export async function applyAstMatches(matches: AstMatch[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	const files = new Map<string, AstMatch[]>();
	for (const match of matches) {
		if (match.replacement === undefined) throw new Error("AST match has no replacement");
		const path = await realpath(resolve(cwd, match.file));
		const existing = files.get(path) ?? [];
		existing.push(match);
		files.set(path, existing);
	}
	const changed: string[] = [];
	for (const [path, entries] of files) {
		signal?.throwIfAborted();
		const original = await readFile(path);
		entries.sort((a, b) => a.range.byteOffset.start - b.range.byteOffset.start);
		const parts: Buffer[] = [];
		let offset = 0;
		for (const entry of entries) {
			const { start, end } = entry.replacementOffsets ?? entry.range.byteOffset;
			if (start < offset || end < start || end > original.length)
				throw new Error("AST replacements overlap or have stale offsets");
			if (
				original.subarray(entry.range.byteOffset.start, entry.range.byteOffset.end).toString("utf8") !== entry.text
			)
				throw new Error("AST match is stale; search the file again");
			parts.push(original.subarray(offset, start), Buffer.from(entry.replacement!));
			offset = end;
		}
		parts.push(original.subarray(offset));
		const replacement = Buffer.concat(parts);
		await replaceFileContents(path, original, replacement, signal);
		changed.push(path);
	}
	return changed;
}

function runAstGrep(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(getAstGrepPath(), args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
		const chunks: Buffer[] = [];
		let diagnostics = "";
		let bytes = 0;
		let failure: Error | undefined;
		const timer = setTimeout(() => {
			failure = new Error("AST search exceeded 30 seconds; narrow paths");
			child.kill();
		}, 30_000);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 2 * 1024 * 1024) {
				failure = new Error("AST output exceeds 2 MiB; narrow the pattern or paths");
				child.kill();
			} else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (diagnostics.length < 16_384) diagnostics += chunk.toString("utf8");
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (failure) reject(failure);
			else if (code !== 0 && code !== 1) reject(new Error(`AST pattern failed: ${diagnostics.trim()}`));
			else resolve(Buffer.concat(chunks).toString("utf8") || "[]");
		});
	});
}
