import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { configuration, root } from "../configuration.mjs";
const lang = process.argv[2];
const base = mkdtempSync(join(tmpdir(), "pi-intelligence-live-"));
const dir = mkdtempSync(join(base, lang + "-"));
const agent = join(dir, "agent"),
	cwd = join(dir, "project");
mkdirSync(agent);
mkdirSync(cwd);
const cases = {
	c: {
		name: "main.c",
		bad: "int main(void){int count=missing_symbol;return count;}\n",
		oldText: "missing_symbol",
		newText: "42",
		astLang: "c",
		errorPattern: "undeclared",
	},
	go: {
		name: "main.go",
		bad: 'package main\nfunc main(){var count int="bad";_ = count}\n',
		oldText: '"bad"',
		newText: "42",
		astLang: "go",
		errorPattern: "cannot use|incompatibleassign",
	},
	rust: {
		name: "src/main.rs",
		bad: 'fn main(){let count:i32="bad";println!("{}",count);}\n',
		oldText: '"bad"',
		newText: "42",
		astLang: "rust",
		errorPattern: "mismatched types|expected `i32`|expected i32",
	},
	javascript: {
		name: "main.js",
		bad: 'export function main(){/** @type {number} */const count="bad";return count;}\n',
		oldText: '"bad"',
		newText: "42",
		astLang: "javascript",
		errorPattern: "not assignable",
	},
	typescript: {
		name: "main.ts",
		bad: 'export function main(){const count:number="bad";return count;}\n',
		oldText: '"bad"',
		newText: "42",
		astLang: "typescript",
		errorPattern: "not assignable",
	},
	python: {
		name: "main.py",
		bad: 'def main()->int:\n count:int="bad"\n return count\n',
		oldText: '"bad"',
		newText: "42",
		astLang: "python",
		errorPattern: "not assignable|cannot be assigned",
	},
};
const s = { ...cases[lang], cwd, language: lang };
assert(s.name);
s.file = join(cwd, s.name);
mkdirSync(dirname(s.file), { recursive: true });
if (lang === "go") writeFileSync(join(cwd, "go.mod"), "module example.com/integrated\n\ngo 1.27\n");
if (lang === "rust")
	writeFileSync(join(cwd, "Cargo.toml"), '[package]\nname="integrated"\nversion="0.1.0"\nedition="2021"\n');
if (["javascript", "typescript"].includes(lang)) {
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, type: "module" }));
	writeFileSync(
		join(cwd, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true, allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true },
			include: ["*.ts", "*.js"],
		}),
	);
}
if (lang === "python")
	writeFileSync(join(cwd, "pyrightconfig.json"), JSON.stringify({ typeCheckingMode: "strict", include: ["*.py"] }));
writeFileSync(join(cwd, ".clang-format"), "BasedOnStyle: LLVM\nAllowShortFunctionsOnASingleLine: None\n");
const cfg = configuration();
mkdirSync(join(agent, "extensions/pi-autoformat"), { recursive: true });
writeFileSync(join(agent, "extensions/pi-autoformat/config.json"), JSON.stringify(cfg.autoformat));
writeFileSync(join(agent, "fovea.json"), JSON.stringify(cfg.fovea));
writeFileSync(join(agent, "pi-fff.json"), JSON.stringify(cfg.fff));
writeFileSync(
	join(agent, "settings.json"),
	JSON.stringify({
		packages: [],
		retry: { enabled: false },
		compaction: { enabled: false },
		cacheWarming: "off",
		defaultTools: ["+tool_search"],
		lsp: cfg.lsp,
	}),
);
writeFileSync(join(dir, "scenario.json"), JSON.stringify(s));
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: agent,
	CI_SCENARIO: join(dir, "scenario.json"),
	CI_RESULTS: join(dir, "results.json"),
	XDG_CACHE_HOME: join(dir, "cache"),
	GOPROXY: "off",
	GOSUMDB: "off",
	GOTOOLCHAIN: "local",
	CARGO_NET_OFFLINE: "true",
};
const child = spawn(
	process.execPath,
	[
		resolve(root, "../../packages/coding-agent/dist/bundle/cli.js"),
		"--mode",
		"rpc",
		"--offline",
		"--no-session",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--provider",
		"integrated-code-smoke",
		"--model",
		"fixture",
		"-e",
		fileURLToPath(new URL("live-provider.mjs", import.meta.url)),
		"-e",
		root + "/index.ts",
	],
	{ cwd, env, stdio: ["pipe", "pipe", "pipe"] },
);
let buf = "",
	stderr = "",
	exited = false;
const events = [];
child.on("exit", () => (exited = true));
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
	buf += d;
	while (buf.includes("\n")) {
		const i = buf.indexOf("\n"),
			line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		try {
			events.push(JSON.parse(line));
		} catch {}
	}
});
try {
	child.stdin.write(
		JSON.stringify({ id: "run", type: "prompt", message: "Run isolated complete integration fixture." }) + "\n",
	);
	const deadline = Date.now() + 240000;
	while (!events.some((e) => e.type === "agent_settled")) {
		if (exited) throw new Error("CLI exited " + stderr);
		if (Date.now() > deadline) throw new Error("timeout " + JSON.stringify(events).slice(-12000));
		await new Promise((r) => setTimeout(r, 50));
	}
	assert(
		events.some(
			(e) =>
				e.type === "message_end" &&
				e.message?.role === "assistant" &&
				Array.isArray(e.message.content) &&
				e.message.content.some((c) => c.text === "INTEGRATED_CYCLE_OK"),
		),
		JSON.stringify(events).slice(-18000),
	);
	console.log(
		JSON.stringify(
			{ language: lang, dir, cases: JSON.parse(readFileSync(env.CI_RESULTS)).map((r) => r.name), passed: true },
			null,
			2,
		),
	);
} finally {
	writeFileSync(join(dir, "events.json"), JSON.stringify(events, null, 2));
	writeFileSync(join(dir, "stderr.log"), stderr);
	child.kill("SIGTERM");
	if (!exited) await new Promise((r) => child.once("exit", r));
	console.log("artifacts", dir);
}
