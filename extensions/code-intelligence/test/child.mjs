import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { configuration, root } from "../configuration.mjs";
const base = mkdtempSync(join(tmpdir(), "pi-intelligence-child-")),
	dir = mkdtempSync(join(base, "stack-child-")),
	cwd = join(dir, "project"),
	agent = join(dir, "agent");
mkdirSync(cwd);
mkdirSync(agent);
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
		lsp: cfg.lsp,
	}),
);
writeFileSync(join(cwd, "go.mod"), "module example.com/stackchild\n\ngo 1.27\n");
writeFileSync(join(cwd, "helper.go"), 'package main\nfunc greet(name string) string {return "hello " + name}\n');
writeFileSync(join(cwd, "main.go"), 'package main\nfunc main(){_ = greet("pi")}\n');
const trace = join(dir, "trace.jsonl");
writeFileSync(trace, "");
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: agent,
	STACK_ROOT: cwd,
	STACK_TRACE: trace,
	XDG_CACHE_HOME: join(dir, "cache"),
	GOPROXY: "off",
	GOSUMDB: "off",
	GOTOOLCHAIN: "local",
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
		"stack-child-smoke",
		"--model",
		"fixture",
		"-e",
		fileURLToPath(new URL("child-provider.mjs", import.meta.url)),
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
		JSON.stringify({
			id: "run",
			type: "prompt",
			message: "Exercise the complete stack across parent and child sessions.",
		}) + "\n",
	);
	const deadline = Date.now() + 180000;
	while (!readFileSync(trace, "utf8").includes("STACK_CHILD_OK")) {
		if (exited) throw Error("CLI exited " + stderr);
		if (Date.now() > deadline) throw Error("timeout " + JSON.stringify(events).slice(-15000));
		await new Promise((r) => setTimeout(r, 50));
	}
	const records = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
	assert.equal(records.filter((r) => r.kind === "start").length, 3);
	assert.equal(records.filter((r) => r.kind === "shutdown").length, 2);
	const check = spawnSync("go", ["test", "./..."], { cwd, env, encoding: "utf8", timeout: 45000 });
	assert.equal(check.status, 0, check.stderr);
	console.log(
		JSON.stringify({ dir, passed: true, cases: records.map((r) => r.kind), compilerExit: check.status }, null, 2),
	);
} finally {
	writeFileSync(join(dir, "events.json"), JSON.stringify(events, null, 2));
	writeFileSync(join(dir, "stderr.log"), stderr);
	child.kill("SIGTERM");
	if (!exited) await new Promise((r) => child.once("exit", r));
	console.log("artifacts", dir);
}
