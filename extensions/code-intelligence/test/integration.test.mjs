import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, stat, chmod, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { formatFile } from "../format-file.mjs";
import { checkFiles } from "../check-files.mjs";
import { configuration, root } from "../configuration.mjs";
import { applyPatches, verifyPatches } from "../apply-patches.mjs";
import { createHash } from "node:crypto";

const jiti = createJiti(import.meta.url);
const lsp = await jiti.import(join(root, "node_modules/@ian-pascoe/pi-lsp/src/lsp-server-client.ts"));
const { SnapshotTracker } = await jiti.import(
	join(root, "node_modules/@gotgenes/pi-autoformat/src/shell-mutation-detector.ts"),
);
const focus = await jiti.import(join(root, "node_modules/pi-fovea/src/core/session.ts"));
async function fixture(t, name = "main.go", source = "package main\nfunc main(){}\n") {
	const directory = await mkdtemp(join(tmpdir(), "pi-intelligence-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, name);
	await writeFile(path, source);
	return { directory, path };
}

test("patches are reproducible, idempotent and reject unexpected source", async (t) => {
	const { directory } = await fixture(t);
	const packagePath = join(directory, "node_modules/example");
	await mkdir(packagePath, { recursive: true });
	await mkdir(join(directory, "patches"));
	await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
	const file = join(packagePath, "source.ts");
	await writeFile(file, "before\n");
	const digest = (text) => createHash("sha256").update(text).digest("hex");
	await writeFile(
		join(directory, "patches/manifest.json"),
		JSON.stringify([
			{
				name: "example",
				version: "1.0.0",
				patch: "example.patch",
				files: [{ path: "source.ts", before: digest("before\n"), after: digest("after\n") }],
			},
		]),
	);
	await writeFile(
		join(directory, "patches/example.patch"),
		"--- a/node_modules/example/source.ts\n+++ b/node_modules/example/source.ts\n@@ -1 +1 @@\n-before\n+after\n",
	);
	await applyPatches(directory);
	await applyPatches(directory);
	await verifyPatches(directory);
	assert.equal(await readFile(file, "utf8"), "after\n");
	await writeFile(file, "foreign edit\n");
	await assert.rejects(applyPatches(directory), /source differs/);
	await assert.rejects(verifyPatches(directory), /patched source mismatch/);
});

test("formatter refuses concurrent edits and preserves the new contents", async (t) => {
	const { path } = await fixture(t);
	await assert.rejects(
		formatFile(path, {
			runner: async () => {
				await writeFile(path, "package replacement\n");
				return { code: 0, stdout: "package original\n", stderr: "" };
			},
		}),
		/concurrent change/,
	);
	assert.equal(await readFile(path, "utf8"), "package replacement\n");
});

test("formatter preserves permissions and Unicode", async (t) => {
	const { path } = await fixture(t, "main.go", "package main\n// привет\nfunc main(){}\n");
	await chmod(path, 0o640);
	assert.equal(await formatFile(path), true);
	assert.match(await readFile(path, "utf8"), /привет/);
	assert.equal((await stat(path)).mode & 0o777, 0o640);
});

test("formatter never replaces a nonempty file with empty output", async (t) => {
	const { path } = await fixture(t);
	const before = await readFile(path);
	await assert.rejects(formatFile(path, { runner: async () => ({ code: 0, stdout: "", stderr: "" }) }), /empty output/);
	assert.deepEqual(await readFile(path), before);
});

test("formatter failures leave the source untouched", async (t) => {
	const { path } = await fixture(t);
	const before = await readFile(path);
	await assert.rejects(
		formatFile(path, { runner: async () => ({ code: 1, stdout: "", stderr: "format failure" }) }),
		/format failure/,
	);
	assert.deepEqual(await readFile(path), before);
});

test("checks reject stale success and stale errors", async (t) => {
	const { directory, path } = await fixture(t);
	await writeFile(join(directory, "go.mod"), "module example.com/test\n\ngo 1.27\n");
	for (const code of [0, 1]) {
		await assert.rejects(
			checkFiles([path], {
				runner: async () => {
					await writeFile(path, `package change${code}\n`);
					return { code, stdout: "outdated compiler output", stderr: "" };
				},
			}),
			/check result is stale/,
		);
	}
});

test("shell snapshots detect same-size edits with unchanged mtime", async (t) => {
	const { directory, path } = await fixture(t, "main.go", "package old\n");
	const before = await stat(path);
	const tracker = new SnapshotTracker({ cwd: directory, globs: ["**/*.go"] });
	tracker.before();
	await writeFile(path, "package new\n");
	await utimes(path, before.atime, before.mtime);
	assert.deepEqual(tracker.after(), [path]);
});

test("shell snapshots find new files and follow renames", async (t) => {
	const { directory, path } = await fixture(t);
	const tracker = new SnapshotTracker({ cwd: directory, globs: ["**/*.go"] });
	tracker.before();
	const next = join(directory, "other.go");
	await writeFile(next, await readFile(path));
	await rm(path);
	assert.deepEqual(tracker.after(), [next]);
});

test("a child focus and shutdown do not reset the parent's focus", () => {
	focus.focusSessionScope.run("parent", () => {
		focus.getSession("/repo").seeds = [1];
	});
	focus.focusSessionScope.run("child", () => {
		assert.deepEqual(focus.getSession("/repo").seeds, []);
		focus.getSession("/repo").seeds = [2];
		focus.resetSessions();
	});
	focus.focusSessionScope.run("parent", () => {
		assert.deepEqual(focus.getSession("/repo").seeds, [1]);
		focus.resetSessions();
	});
});

test("configuration preserves native tools and disables autonomous map turns", () => {
	const cfg = configuration();
	assert.equal(cfg.fff.mode, "tools-only");
	assert.equal(cfg.fovea.sync.mode, "disabled");
	assert.equal(cfg.fovea.tools.grepMode, "off");
	assert.equal(cfg.lsp.servers.typescript.args.at(-2), "--lsp");
	assert.deepEqual(
		cfg.autoformat.customMutationTools.map((item) => item.toolName),
		["hashline_edit", "ast_grep_replace"],
	);
});

for (const mode of ["versioned", "unversioned", "rust"]) {
	test(`LSP diagnostic freshness: ${mode}`, async (t) => {
		const { directory, path } = await fixture(t, "main.rs", "fn main() {}\n");
		const program = fileURLToPath(new URL("fixtures/lsp-server.mjs", import.meta.url));
		let command = process.execPath,
			args = [program];
		if (mode === "rust") {
			command = join(directory, "rust-analyzer");
			args = [];
			await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${program}'\n`, { mode: 0o755 });
		}
		const client = await lsp.LspServerClient.start({
			serverId: mode,
			rootPath: directory,
			command,
			args,
			environment: { ...process.env, FIXTURE_MODE: mode },
			settings: {},
			initializationOptions: {},
			maxConcurrentDiagnostics: 2,
			timeouts: {
				initializeMs: 2000,
				requestMs: 1000,
				workspaceRequestMs: 1000,
				diagnosticsMs: mode === "unversioned" ? 120 : 2000,
				shutdownMs: 1000,
			},
			stderrPath: join(directory, "server.log"),
		});
		t.after(() => client.shutdown());
		const start = Date.now();
		const result = await client.documentDiagnostics(path, "rust");
		if (mode === "unversioned") {
			assert.equal(result.status, "timeout");
			assert.deepEqual(result.diagnostics, []);
		} else {
			assert.equal(result.status, "fresh");
			assert.equal(result.diagnostics[0].message, "current error");
			assert(Date.now() - start >= (mode === "rust" ? 80 : 50));
		}
	});
}
