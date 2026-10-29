// validates LSP text edits and applies them without silently accepting resource operations.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { replaceFileContents } from "../../core/tools/atomic-edit.ts";

export type LspEditPlan = { path: string; original: Buffer; replacement: Buffer };

/** Plan nonoverlapping UTF-16 workspace text edits, rejecting unsupported create/delete/rename operations. */
export async function planLspEdits(value: JsonValue): Promise<LspEditPlan[]> {
	if (!object(value)) throw new Error("Language server returned no workspace edit");
	const byUri = new Map<string, JsonValue[]>();
	if (object(value.changes)) {
		for (const [uri, edits] of Object.entries(value.changes)) {
			if (!Array.isArray(edits)) throw new Error("Invalid LSP text edit list");
			byUri.set(uri, [...edits]);
		}
	}
	if (Array.isArray(value.documentChanges)) {
		for (const document of value.documentChanges) {
			if (
				!object(document) ||
				!object(document.textDocument) ||
				typeof document.textDocument.uri !== "string" ||
				!Array.isArray(document.edits)
			)
				throw new Error("LSP resource operations are not supported; use explicit file tools");
			const previous = byUri.get(document.textDocument.uri) ?? [];
			previous.push(...document.edits);
			byUri.set(document.textDocument.uri, previous);
		}
	}
	const plans: LspEditPlan[] = [];
	for (const [uri, edits] of byUri) {
		let path: string;
		try {
			path = fileURLToPath(uri);
		} catch {
			throw new Error("LSP edits must target local file URIs");
		}
		const original = await readFile(path);
		const text = original.toString("utf8");
		const changes = edits
			.map((edit) => {
				if (!object(edit) || !object(edit.range) || typeof edit.newText !== "string")
					throw new Error("Invalid LSP text edit");
				return {
					start: positionOffset(text, edit.range.start),
					end: positionOffset(text, edit.range.end),
					text: edit.newText,
				};
			})
			.sort((a, b) => a.start - b.start);
		let position = 0;
		let lastStart = -1;
		const parts: string[] = [];
		for (const change of changes) {
			if (change.start < position || change.start === lastStart || change.end < change.start)
				throw new Error("LSP text edits overlap or have invalid ranges");
			parts.push(text.slice(position, change.start), change.text);
			position = change.end;
			lastStart = change.start;
		}
		parts.push(text.slice(position));
		plans.push({ path, original, replacement: Buffer.from(parts.join("")) });
	}
	return plans;
}

/** Publish each planned file only if its full bytes still match; multi-file edits are not transactional. */
export async function applyLspEdits(plans: LspEditPlan[], signal?: AbortSignal): Promise<string[]> {
	const changed: string[] = [];
	for (const plan of plans) {
		await replaceFileContents(plan.path, plan.original, plan.replacement, signal);
		changed.push(plan.path);
	}
	return changed;
}

function positionOffset(text: string, value: JsonValue | undefined): number {
	if (
		!object(value) ||
		typeof value.line !== "number" ||
		typeof value.character !== "number" ||
		!Number.isInteger(value.line) ||
		!Number.isInteger(value.character) ||
		value.line < 0 ||
		value.character < 0
	)
		throw new Error("Invalid LSP position");
	let start = 0;
	for (let line = 0; line < value.line; line++) {
		const next = text.indexOf("\n", start);
		if (next === -1) throw new Error("LSP position is beyond the file");
		start = next + 1;
	}
	const end = text.indexOf("\n", start);
	const lineEnd = end === -1 ? text.length : end > start && text[end - 1] === "\r" ? end - 1 : end;
	if (start + value.character > lineEnd) throw new Error("LSP character is beyond the line");
	return start + value.character;
}

function object(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
