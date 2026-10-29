// manages language-server workspaces, document versions and active diagnostics.
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { LspRpc } from "./lsp-rpc.ts";

export type LspDiagnostic = {
	path: string;
	line: number;
	character: number;
	severity: "error" | "warning" | "information" | "hint";
	message: string;
	code?: string | number;
	source?: string;
};
export type LspServerCommands = Record<string, string[]>;
type DocumentState = { version: number; text: string };
type Server = {
	rpc: LspRpc;
	capabilities: JsonObject;
	documents: Map<string, DocumentState>;
	diagnostics: Map<string, LspDiagnostic[]>;
	root: string;
};

const LANGUAGES: Record<string, string> = {
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".hpp": "cpp",
	".go": "go",
	".rs": "rust",
	".zig": "zig",
	".py": "python",
	".ts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".jsx": "javascriptreact",
	".sh": "shellscript",
	".json": "json",
};
const COMMANDS: LspServerCommands = {
	c: ["clangd", "--background-index=false"],
	cpp: ["clangd", "--background-index=false"],
	go: ["gopls"],
	rust: ["rust-analyzer"],
	zig: ["zls"],
	python: ["pyright-langserver", "--stdio"],
	typescript: ["typescript-language-server", "--stdio"],
	typescriptreact: ["typescript-language-server", "--stdio"],
	javascript: ["typescript-language-server", "--stdio"],
	javascriptreact: ["typescript-language-server", "--stdio"],
	shellscript: ["bash-language-server", "start"],
	json: ["vscode-json-language-server", "--stdio"],
};

/** Own language-server processes for one agent session, sharing by command and workspace. */
export class LanguageServers {
	private readonly servers = new Map<string, Promise<Server>>();
	private readonly commands: LspServerCommands;
	private closed = false;

	constructor(commands: LspServerCommands = {}) {
		this.commands = { ...COMMANDS, ...commands };
	}

	/** Tell callers whether a supported language has an executable server on PATH. */
	supports(path: string): boolean {
		const language = LANGUAGES[extname(path)];
		const program = language && this.commands[language]?.[0];
		if (!program) return false;
		const candidates = program.includes("/")
			? [program]
			: (process.env.PATH ?? "")
					.split(delimiter)
					.filter(Boolean)
					.map((dir) => join(dir, program));
		return candidates.some((candidate) => {
			try {
				accessSync(candidate, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
	}

	/** Open or synchronize a file, then perform an LSP method with one-based input positions. */
	async request(
		method: string,
		path: string,
		cwd: string,
		options: { line?: number; character?: number; params?: JsonObject; signal?: AbortSignal } = {},
	): Promise<JsonValue> {
		const { server, uri } = await this.document(path, cwd, options.signal);
		const position = { line: (options.line ?? 1) - 1, character: (options.character ?? 1) - 1 };
		return server.rpc.request(method, { textDocument: { uri }, position, ...options.params }, options.signal);
	}

	/** Actively probe pull diagnostics or wait for the current synchronized document's push diagnostics. */
	async diagnostics(
		path: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<{ diagnostics: LspDiagnostic[]; confirmed: boolean }> {
		const { server, uri } = await this.document(path, cwd, signal);
		if (server.capabilities.diagnosticProvider) {
			const report = await server.rpc.request("textDocument/diagnostic", { textDocument: { uri } }, signal);
			if (object(report) && Array.isArray(report.items))
				return { diagnostics: decodeDiagnostics(uri, report.items), confirmed: true };
			return { diagnostics: [], confirmed: false };
		}
		// push-only servers may stay silent for clean files; never call that silence a confirmed clean result.
		for (let attempt = 0; attempt < 15 && !server.diagnostics.has(uri); attempt++) {
			signal?.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return { diagnostics: server.diagnostics.get(uri) ?? [], confirmed: server.diagnostics.has(uri) };
	}

	/** Run a workspace method after initializing the server selected by a file. */
	async workspaceRequest(
		method: string,
		path: string,
		cwd: string,
		params: JsonObject,
		signal?: AbortSignal,
	): Promise<JsonValue> {
		const { server } = await this.document(path, cwd, signal);
		return server.rpc.request(method, params, signal);
	}

	/** Close every owned server, including any server still initializing. */
	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.servers.values()].map(async (pending) => (await pending).rpc.close()));
		this.servers.clear();
	}

	private async document(path: string, cwd: string, signal?: AbortSignal): Promise<{ server: Server; uri: string }> {
		if (this.closed) throw new Error("Language-server owner is closed");
		signal?.throwIfAborted();
		const fullPath = resolve(cwd, path);
		const language = LANGUAGES[extname(fullPath)];
		const command = language ? this.commands[language] : undefined;
		if (!language || !command?.length || !this.supports(fullPath))
			throw new Error("No language server installed or configured for this file type");
		const key = `${resolve(cwd)}\0${JSON.stringify(command)}`;
		let pending = this.servers.get(key);
		if (!pending) {
			pending = this.start(command, resolve(cwd)).catch((error: unknown) => {
				this.servers.delete(key);
				throw error;
			});
			this.servers.set(key, pending);
		}
		const server = await pending;
		if (this.closed) throw new Error("Language-server owner is closed");
		signal?.throwIfAborted();
		const uri = pathToFileURL(fullPath).href;
		const text = await readFile(fullPath, "utf8");
		const previous = server.documents.get(uri);
		if (!previous) {
			server.documents.set(uri, { version: 1, text });
			server.diagnostics.delete(uri);
			server.rpc.notify("textDocument/didOpen", { textDocument: { uri, languageId: language, version: 1, text } });
		} else if (previous.text !== text) {
			const oldText = previous.text;
			previous.text = text;
			previous.version++;
			server.diagnostics.delete(uri);
			const sync = server.capabilities.textDocumentSync;
			const kind = typeof sync === "number" ? sync : object(sync) ? sync.change : 1;
			if (kind === 2) {
				// replacing the complete old document is a valid incremental edit with explicit UTF-16 end position.
				const lines = oldText.split("\n");
				const oldLines = { line: lines.length - 1, character: lines[lines.length - 1].replace(/\r$/, "").length };
				server.rpc.notify("textDocument/didChange", {
					textDocument: { uri, version: previous.version },
					contentChanges: [{ range: { start: { line: 0, character: 0 }, end: oldLines }, text }],
				});
			} else
				server.rpc.notify("textDocument/didChange", {
					textDocument: { uri, version: previous.version },
					contentChanges: [{ text }],
				});
			server.rpc.notify("textDocument/didSave", { textDocument: { uri }, text });
		}
		return { server, uri };
	}

	private async start(command: string[], root: string): Promise<Server> {
		const diagnostics = new Map<string, LspDiagnostic[]>();
		const documents = new Map<string, DocumentState>();
		const folders = [{ uri: pathToFileURL(root).href, name: root.split("/").pop() ?? root }];
		const rpc = new LspRpc(
			command,
			root,
			(message) => {
				if (message.method !== "textDocument/publishDiagnostics" || !object(message.params)) return;
				const { uri, diagnostics: items, version } = message.params;
				if (typeof uri !== "string" || !Array.isArray(items)) return;
				const expected = documents.get(uri);
				if (typeof version === "number" && expected && version < expected.version) return;
				diagnostics.set(uri, decodeDiagnostics(uri, items));
			},
			(method, params) => {
				if (method === "workspace/configuration")
					return object(params) && Array.isArray(params.items) ? params.items.map(() => ({})) : [];
				if (method === "workspace/workspaceFolders") return folders;
				if (method === "workspace/applyEdit")
					return { applied: false, failureReason: "Use an explicit pi editing tool" };
				return null;
			},
		);
		try {
			const result = await rpc.request(
				"initialize",
				{
					processId: process.pid,
					rootUri: pathToFileURL(root).href,
					workspaceFolders: folders,
					capabilities: {
						workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
						textDocument: {
							synchronization: { didSave: true, dynamicRegistration: false },
							publishDiagnostics: { versionSupport: true },
							diagnostic: { dynamicRegistration: false },
							hover: { contentFormat: ["plaintext", "markdown"] },
						},
					},
				},
				undefined,
				30_000,
			);
			if (!object(result) || !object(result.capabilities))
				throw new Error("Language server returned invalid capabilities");
			rpc.notify("initialized", {});
			return { rpc, capabilities: result.capabilities, documents, diagnostics, root };
		} catch (error) {
			await rpc.close();
			throw error;
		}
	}
}

function object(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeDiagnostics(uri: string, values: readonly JsonValue[]): LspDiagnostic[] {
	let path: string;
	try {
		path = fileURLToPath(uri);
	} catch {
		return [];
	}
	const result: LspDiagnostic[] = [];
	for (const item of values) {
		if (!object(item) || typeof item.message !== "string" || !object(item.range) || !object(item.range.start))
			continue;
		const { line, character } = item.range.start;
		if (typeof line !== "number" || typeof character !== "number") continue;
		const severity =
			item.severity === 1 ? "error" : item.severity === 2 ? "warning" : item.severity === 4 ? "hint" : "information";
		result.push({
			path,
			line: line + 1,
			character: character + 1,
			severity,
			message: item.message,
			...(typeof item.code === "string" || typeof item.code === "number" ? { code: item.code } : {}),
			...(typeof item.source === "string" ? { source: item.source } : {}),
		});
	}
	return result;
}
