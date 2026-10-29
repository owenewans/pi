// reads and edits UTF-8 files with content-hashed line anchors and stale-write protection.
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { replaceFileContents } from "../../core/tools/atomic-edit.ts";

export type HashlineEdit =
	| { op: "replace"; start: string; end?: string; lines: string[] }
	| { op: "insert_before" | "insert_after"; anchor: string; lines: string[] }
	| { op: "append"; lines: string[] };
export type HashlineRead = { path: string; version: string; content: string; totalLines: number; nextLine?: number };

/** Read numbered hash anchors from a bounded UTF-8 file range. */
export async function readHashlines(path: string, cwd: string, offset = 1, limit = 500): Promise<HashlineRead> {
	const fullPath = resolve(cwd, path);
	const bytes = await readFile(fullPath);
	const { lines } = decodeLines(bytes);
	const start = offset - 1;
	if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 2000)
		throw new Error("Invalid hashline offset or limit");
	const content = lines
		.slice(start, start + limit)
		.map((line, index) => `${start + index + 1}:${lineHash(line)}|${line}`)
		.join("\n");
	if (Buffer.byteLength(content) > 256 * 1024) throw new Error("Hashline range exceeds 256 KiB; read fewer lines");
	return {
		path: fullPath,
		version: createHash("sha256").update(bytes).digest("hex"),
		content,
		totalLines: lines.length,
		...(start + limit < lines.length ? { nextLine: start + limit + 1 } : {}),
	};
}

/** Apply only operations anchored to the current file, rejecting overlapping or stale edits. */
export async function editHashlines(
	path: string,
	edits: HashlineEdit[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ path: string; changedLines: number }> {
	const fullPath = resolve(cwd, path);
	const bytes = await readFile(fullPath);
	const { lines, newline, trailing } = decodeLines(bytes);
	const changes: { start: number; end: number; lines: string[] }[] = [];
	const anchor = (value: string): number => {
		const match = /^(\d+):([a-f0-9]{8})$/.exec(value);
		if (!match) throw new Error("Hashline anchor must use LINE:HASH from the latest hashline_read");
		const index = Number(match[1]) - 1;
		if (index < 0 || index >= lines.length || lineHash(lines[index]) !== match[2])
			throw new Error(`Stale hashline anchor ${value}; read the file again`);
		return index;
	};
	for (const edit of edits) {
		if (edit.lines.some((line) => /[\r\n]/.test(line)))
			throw new Error("Each replacement array entry must contain one line without newline characters");
		if (edit.op === "append") changes.push({ start: lines.length, end: lines.length, lines: edit.lines });
		else if (edit.op === "replace") {
			const start = anchor(edit.start);
			const end = anchor(edit.end ?? edit.start) + 1;
			if (end <= start) throw new Error("Hashline range ends before its start");
			changes.push({ start, end, lines: edit.lines });
		} else {
			const position = anchor(edit.anchor) + (edit.op === "insert_after" ? 1 : 0);
			changes.push({ start: position, end: position, lines: edit.lines });
		}
	}
	changes.sort((a, b) => a.start - b.start);
	const result: string[] = [];
	let previousEnd = 0;
	let previousStart = -1;
	for (const change of changes) {
		if (change.start < previousEnd || change.start === previousStart)
			throw new Error("Hashline edits overlap or use the same insertion point");
		result.push(...lines.slice(previousEnd, change.start), ...change.lines);
		previousEnd = change.end;
		previousStart = change.start;
	}
	result.push(...lines.slice(previousEnd));
	const text = result.join(newline) + (trailing && result.length ? newline : "");
	await replaceFileContents(fullPath, bytes, Buffer.from(text), signal);
	return {
		path: fullPath,
		changedLines: changes.reduce((count, edit) => count + Math.max(edit.end - edit.start, edit.lines.length), 0),
	};
}

function lineHash(line: string): string {
	return createHash("sha256").update(line).digest("hex").slice(0, 8);
}

function decodeLines(bytes: Buffer): { lines: string[]; newline: string; trailing: boolean } {
	if (bytes.length > 4 * 1024 * 1024) throw new Error("Hashline editing is limited to 4 MiB files");
	if (!isUtf8(bytes) || bytes.includes(0)) throw new Error("Hashline editing requires UTF-8 text");
	const text = bytes.toString("utf8");
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	if (newline === "\r\n" && text.replaceAll("\r\n", "").includes("\n"))
		throw new Error("Mixed line endings require normalization before hashline editing");
	const trailing = text.endsWith(newline);
	const lines = text ? text.split(newline) : [];
	if (trailing) lines.pop();
	return { lines, newline, trailing };
}
