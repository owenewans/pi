// exposes AST search, hashline editing and language-server navigation with post-write diagnostics.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { applyAstMatches, searchAst } from "./ast.ts";
import { Debugger } from "./debugger.ts";
import { editHashlines, readHashlines } from "./hashline.ts";
import { LanguageServers } from "./lsp.ts";
import { applyLspEdits, planLspEdits } from "./lsp-edits.ts";

export default function codeExtension(pi: ExtensionAPI): void {
	let servers = new LanguageServers();
	const debuggerSession = new Debugger();
	let closed = false;
	pi.on("session_start", () => {
		if (closed) {
			servers = new LanguageServers();
			closed = false;
		}
	});
	pi.on("session_shutdown", async () => {
		closed = true;
		await Promise.all([servers.close(), debuggerSession.close()]);
	});
	pi.on("tool_result", async (event, ctx) => {
		if (
			event.isError ||
			!["write", "edit", "hashline_edit"].includes(event.toolName) ||
			typeof event.input.path !== "string" ||
			!servers.supports(event.input.path)
		)
			return;
		try {
			const result = await servers.diagnostics(event.input.path, ctx.cwd, AbortSignal.timeout(10_000));
			const text = result.confirmed
				? JSON.stringify(result.diagnostics)
				: "Diagnostics not confirmed: server did not publish a result.";
			return { content: [...event.content, { type: "text", text: `Language-server diagnostics: ${text}` }] };
		} catch {
			return {
				content: [
					...event.content,
					{ type: "text", text: "Language-server diagnostics unavailable; check the server installation." },
				],
			};
		}
	});
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
			"Preview or apply structural replacements on exactly one file. apply defaults to false. The engine resolves metavariables; applied byte ranges must be nonoverlapping and match current file bytes. File permissions are preserved; changed files receive LSP diagnostics when a server is installed.",
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
			const diagnostics = await diagnosticsFor(changed, servers, ctx.cwd, signal);
			return { content: [{ type: "text", text: JSON.stringify({ matches, changed, diagnostics }) }], details: {} };
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
	pi.registerTool({
		name: "lsp_navigation",
		label: "Language server",
		description:
			"Navigate through installed language servers. Operations: definition, references, hover, documentSymbol, workspaceSymbol, diagnostics and rename. path selects the server; line and character are one-based UTF-16 positions. Rename previews changes by default; apply=true writes text edits atomically per file, not as one transaction. Resource operations are refused.",
		parameters: Type.Object({
			operation: Type.Union(
				["definition", "references", "hover", "documentSymbol", "workspaceSymbol", "diagnostics", "rename"].map(
					(value) => Type.Literal(value),
				),
			),
			path: Type.String({ minLength: 1 }),
			line: Type.Optional(Type.Integer({ minimum: 1 })),
			character: Type.Optional(Type.Integer({ minimum: 1 })),
			query: Type.Optional(Type.String()),
			newName: Type.Optional(Type.String({ minLength: 1 })),
			apply: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			let result: unknown;
			if (params.operation === "diagnostics") result = await servers.diagnostics(params.path, ctx.cwd, signal);
			else if (params.operation === "workspaceSymbol")
				result = await servers.workspaceRequest(
					"workspace/symbol",
					params.path,
					ctx.cwd,
					{ query: params.query ?? "" },
					signal,
				);
			else if (params.operation === "rename") {
				if (!params.newName) throw new Error("rename requires newName");
				const edit = await servers.request("textDocument/rename", params.path, ctx.cwd, {
					line: params.line,
					character: params.character,
					params: { newName: params.newName },
					signal,
				});
				const plans = await planLspEdits(edit);
				const changed = params.apply ? await applyLspEdits(plans, signal) : [];
				result = { edit, changed, diagnostics: await diagnosticsFor(changed, servers, ctx.cwd, signal) };
			} else {
				const method =
					params.operation === "documentSymbol"
						? "textDocument/documentSymbol"
						: `textDocument/${params.operation}`;
				const extra = params.operation === "references" ? { context: { includeDeclaration: true } } : undefined;
				result = await servers.request(method, params.path, ctx.cwd, {
					line: params.line,
					character: params.character,
					params: extra,
					signal,
				});
			}
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
}

async function diagnosticsFor(paths: string[], servers: LanguageServers, cwd: string, signal?: AbortSignal) {
	return Promise.all(
		paths.map(async (path) => {
			if (!servers.supports(path)) return { path, confirmed: false, reason: "No language server installed" };
			try {
				return { path, ...(await servers.diagnostics(path, cwd, signal)) };
			} catch {
				signal?.throwIfAborted();
				return { path, confirmed: false, reason: "Language-server diagnostics unavailable" };
			}
		}),
	);
}
