// tests relocated development scripts without using account credentials or network access.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { workspaceSourcePaths } from "./vitest.base.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("shared test aliases resolve to checkout source files", () => {
	for (const path of Object.values(workspaceSourcePaths))
		assert.ok(existsSync(path), path);
	for (const config of [
		"packages/coding-agent/vitest.config.ts",
		"packages/evals/vitest.test.config.ts",
		"packages/evals/vitest.evals.config.ts",
	]) {
		assert.ok(
			readFileSync(join(root, config), "utf8").includes(
				'"../../scripts/vitest.base.ts"',
			),
			config,
		);
	}
});

test("keeps configuration and scripts out of the root", () => {
	for (const path of [
		"vitest.base.ts",
		"test.sh",
		"pi-test.sh",
		"pi-test.ps1",
		"pi-test.bat",
		"biome.json",
		"flake.nix",
		"flake.lock",
		"nix",
		".husky",
	]) {
		assert.equal(existsSync(join(root, path)), false, path);
	}
	for (const path of [
		"scripts/test.sh",
		"scripts/pi-test.sh",
		"scripts/vitest.base.ts",
		"scripts/biome.config.json",
		"license",
	]) {
		assert.ok(existsSync(join(root, path)), path);
	}
});

test("remaining workflows parse and have no deleted local workflow dependencies", () => {
	for (const file of readdirSync(join(root, ".github/workflows"))) {
		if (!file.endsWith(".yml")) continue;
		const text = readFileSync(join(root, ".github/workflows", file), "utf8");
		const document = parseDocument(text);
		assert.deepEqual(document.errors, [], file);
		assert.deepEqual(document.warnings, [], file);
		for (const match of text.matchAll(/uses:\s*(\.\/[^\s]+)/g))
			assert.ok(existsSync(join(root, match[1])), match[1]);
		assert.doesNotMatch(
			text,
			/macos-latest|windows-latest|APPROVED_CONTRIBUTORS|preview-packages/,
		);
	}
});

test("test runner starts from any directory and isolates credentials and home", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-script-layout-"));
	try {
		const npm = join(directory, "npm");
		writeFileSync(
			npm,
			`#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, hasCredential: Boolean(process.env.ANTHROPIC_API_KEY), hasSentinel: Boolean(process.env.PI_TEST_SENTINEL), offline: process.env.PI_NO_LOCAL_LLM, gitPrompt: process.env.GIT_TERMINAL_PROMPT }));\n`,
			{ mode: 0o700 },
		);
		const result = spawnSync("bash", [join(root, "scripts/test.sh")], {
			cwd: directory,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${directory}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
				ANTHROPIC_API_KEY: "fixture-not-a-real-key",
				PI_TEST_SENTINEL: "fixture",
			},
		});
		assert.equal(result.status, 0, result.stderr);
		const lines = result.stdout.trim().split("\n");
		const environment = JSON.parse(lines[lines.length - 1]);
		assert.deepEqual(environment.args, ["test"]);
		assert.equal(environment.cwd, root.replace(/\/$/, ""));
		assert.equal(environment.hasCredential, false);
		assert.equal(environment.hasSentinel, false);
		assert.equal(environment.offline, "1");
		assert.equal(environment.gitPrompt, "0");
		assert.ok(environment.home.startsWith(join(tmpdir(), "pi-test.")));
		assert.equal(existsSync(environment.home), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
