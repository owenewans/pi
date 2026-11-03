import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const root = dirname(fileURLToPath(import.meta.url));
export function configuration({ go = join(homedir(), "go/bin/gopls"), rust = join(root, "tools/rust-analyzer") } = {}) {
	const language = (extensions, languageId) => ({ extensions, languageId });
	const server = (command, languages, rootMarkers, extra = {}) => ({ command, languages, rootMarkers, ...extra });
	return {
		lsp: {
			timeouts: {
				initializeMs: 45000,
				requestMs: 10000,
				workspaceRequestMs: 30000,
				diagnosticsMs: 5000,
				shutdownMs: 3000,
			},
			servers: {
				clangd: server(
					"clangd",
					[language([".c", ".h"], "c"), language([".cpp", ".cc", ".cxx", ".hpp"], "cpp")],
					["compile_commands.json", ".clangd", ".git"],
					{ args: ["--background-index", "--log=error"] },
				),
				go: server(go, [language([".go"], "go")], ["go.mod", "go.work"], {
					environment: { GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local" },
				}),
				rust: server(rust, [language([".rs"], "rust")], ["Cargo.toml"], {
					environment: { CARGO_NET_OFFLINE: "true" },
					settings: { "rust-analyzer": { checkOnSave: true, cargo: { offline: true } } },
				}),
				typescript: server(
					process.execPath,
					[
						language([".js", ".mjs", ".cjs"], "javascript"),
						language([".jsx"], "javascriptreact"),
						language([".ts", ".mts", ".cts"], "typescript"),
						language([".tsx"], "typescriptreact"),
					],
					["tsconfig.json", "jsconfig.json", "package.json"],
					{ args: [join(root, "node_modules/typescript/bin/tsc"), "--lsp", "--stdio"] },
				),
				python: server(
					process.execPath,
					[language([".py", ".pyi"], "python")],
					["pyrightconfig.json", "pyproject.toml", "setup.py", ".git"],
					{ args: [join(root, "node_modules/pyright/langserver.index.js"), "--stdio"] },
				),
			},
		},
		fovea: { sync: { mode: "disabled" }, tools: { grepMode: "off", defaultBudget: 800 } },
		fff: { mode: "tools-only" },
		autoformat: {
			commandTimeoutMs: 45000,
			formatterOutput: { onFailure: "both", maxBytes: 12000, maxLines: 100 },
			shellMutationDetection: {
				enabled: true,
				argumentParsing: true,
				snapshotGlobs: ["**/*.{c,h,cc,cpp,hpp,go,rs,js,jsx,mjs,cjs,ts,tsx,mts,cts,py,sh,zig}"],
			},
			customMutationTools: [
				{ toolName: "hashline_edit", pathField: "path" },
				{ toolName: "ast_grep_replace", pathField: "path" },
			],
			formatters: {
				format: { command: [process.execPath, join(root, "format-file.mjs")] },
				check: { command: [process.execPath, join(root, "check-files.mjs")] },
			},
			chains: Object.fromEntries(
				[
					".c",
					".h",
					".cc",
					".cpp",
					".hpp",
					".go",
					".rs",
					".js",
					".jsx",
					".mjs",
					".cjs",
					".ts",
					".tsx",
					".mts",
					".cts",
					".py",
					".sh",
					".zig",
					".json",
					".jsonc",
				].map((ext) => [ext, ["format", ...([".h", ".hpp", ".json", ".jsonc"].includes(ext) ? [] : ["check"])]]),
			),
		},
	};
}
