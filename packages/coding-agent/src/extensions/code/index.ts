// exposes AST search, hashline editing and a persistent debugger.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { applyAstMatches, searchAst } from "./ast.ts";
import { Debugger } from "./debugger.ts";
import { editHashlines, readHashlines } from "./hashline.ts";

export default function codeExtension(pi: ExtensionAPI): void {
	const debuggerSession = new Debugger();
	pi.on("session_shutdown", () => debuggerSession.close());
	pi.registerTool({
		name: "debugger",
		label: "Debugger",
		description:
			"Run a persistent local GDB machine-interface session. action=start opens a compiled executable and literal arguments; command sends one GDB MI command, read retrieves asynchronous stop events and program output, close terminates the debugger and its program. Example: -break-insert main, -exec-run, read until *stopped, -stack-list-frames, -data-evaluate-expression x. Requires gdb and debug symbols. Cancelling a command stops waiting, not the inferior.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"),
				Type.Literal("command"),
				Type.Literal("read"),
				Type.Literal("close"),
			]),
			program: Type.Optional(Type.String({ minLength: 1 })),
			args: Type.Optional(Type.Array(Type.String())),
			command: Type.Optional(Type.String({ minLength: 1 })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			let result: string | string[];
			if (params.action === "start") {
				if (!params.program) throw new Error("start requires program");
				await debuggerSession.start(params.program, params.args ?? [], ctx.cwd);
				result = "Debugger started";
			} else if (params.action === "command") {
				if (!params.command) throw new Error("command requires an MI command");
				result = await debuggerSession.command(params.command, signal);
			} else if (params.action === "read") result = debuggerSession.read();
			else {
				await debuggerSession.close();
				result = "Debugger closed";
			}
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
	pi.registerTool({
		name: "ast_grep_search",
		label: "AST search",
		description:
			"Search structurally with pinned ast-grep. Set lang and a valid single-node AST pattern; $NAME captures one node and $$$NAME captures multiple. Paths default to cwd, / is forbidden. Results include exact text, byte ranges and locations. Match limits narrow returned output; narrow paths or pattern if the engine exceeds its output budget.",
		parameters: Type.Object({
			pattern: Type.String({ minLength: 1 }),
			lang: Type.String({ minLength: 1 }),
			paths: Type.Optional(Type.Array(Type.String())),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const matches = await searchAst(
				{ pattern: params.pattern, lang: params.lang, paths: params.paths ?? [], signal },
				ctx.cwd,
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ total: matches.length, matches: matches.slice(0, params.limit ?? 100) }),
					},
				],
				details: {},
			};
		},
	});
	pi.registerTool({
		name: "ast_grep_replace",
		label: "AST replace",
		description:
			"Preview or apply structural replacements on exactly one file. apply defaults to false. The engine resolves metavariables; applied byte ranges must be nonoverlapping and match current file bytes. File permissions are preserved.",
		parameters: Type.Object({
			pattern: Type.String({ minLength: 1 }),
			rewrite: Type.String(),
			lang: Type.String({ minLength: 1 }),
			path: Type.String({ minLength: 1 }),
			apply: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!(await stat(resolve(ctx.cwd, params.path))).isFile())
				throw new Error("AST replace requires one regular file");
			const matches = await searchAst(
				{ pattern: params.pattern, rewrite: params.rewrite, lang: params.lang, paths: [params.path], signal },
				ctx.cwd,
			);
			const changed = params.apply ? await applyAstMatches(matches, ctx.cwd, signal) : [];
			return { content: [{ type: "text", text: JSON.stringify({ matches, changed }) }], details: {} };
		},
	});
	pi.registerTool({
		name: "hashline_read",
		label: "Hashline read",
		description:
			"Read a UTF-8 file as LINE:HASH|text anchors for hashline_edit. Read again after changes; stale hashes are rejected. Supports pagination and preserves line endings.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1 }),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const result = await readHashlines(params.path, ctx.cwd, params.offset, params.limit);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
	pi.registerTool({
		name: "hashline_edit",
		label: "Hashline edit",
		description:
			"Apply anchored line edits from the latest hashline_read. Each operation uses exact LINE:HASH anchors and an array of replacement lines. replace covers an inclusive range; insert_before/after use an anchor; append adds at EOF. Overlap or stale anchors fail without writing.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1 }),
			edits: Type.Array(
				Type.Union([
					Type.Object({
						op: Type.Literal("replace"),
						start: Type.String(),
						end: Type.Optional(Type.String()),
						lines: Type.Array(Type.String()),
					}),
					Type.Object({
						op: Type.Union([Type.Literal("insert_before"), Type.Literal("insert_after")]),
						anchor: Type.String(),
						lines: Type.Array(Type.String()),
					}),
					Type.Object({ op: Type.Literal("append"), lines: Type.Array(Type.String()) }),
				]),
				{ minItems: 1 },
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const result = await editHashlines(params.path, params.edits, ctx.cwd, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
}
