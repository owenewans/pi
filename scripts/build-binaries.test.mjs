// tests Linux binary packaging with a local compiler fixture and no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-binaries.sh", import.meta.url));

test("packages only Linux targets, skills and license without deleting unrelated output", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-binaries-"));
	try {
		const packageRoot = join(root, "packages/coding-agent");
		const files = {
			"scripts/build-binaries.sh": readFileSync(script, "utf8"),
			license: "upstream MIT license fixture\n",
			"packages/coding-agent/package.json": "{}\n",
			"packages/coding-agent/scripts/telegram-service.py": "fixture\n",
			"packages/coding-agent/dist/modes/interactive/theme/dark.json": "{}\n",
			"packages/coding-agent/dist/modes/interactive/assets/logo.txt": "fixture\n",
			"packages/coding-agent/dist/core/export-html/index.html": "fixture\n",
			"packages/coding-agent/docs/guide.md": "fixture\n",
			"packages/coding-agent/examples/example.ts": "fixture\n",
			"packages/coding-agent/skills/commit.md": "fixture\n",
			"packages/tui/native/linux/prebuilds/linux-x64/helper": "fixture\n",
			"packages/tui/native/linux/prebuilds/linux-arm64/helper": "fixture\n",
			"node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm": "fixture\n",
			"node_modules/@ast-grep/cli-linux-x64-gnu/ast-grep": "fixture\n",
			"node_modules/@ast-grep/cli-linux-arm64-gnu/ast-grep": "fixture\n",
			"output/unrelated": "keep me\n",
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "bun"),
			`#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nfs.writeFileSync(args[args.indexOf("--outfile") + 1], "binary fixture\\n");\n`,
			{ mode: 0o700 },
		);
		const result = spawnSync(
			"bash",
			[
				join(root, "scripts/build-binaries.sh"),
				"--skip-install",
				"--skip-build",
				"--out",
				"output",
			],
			{
				cwd: tmpdir(),
				encoding: "utf8",
				env: { PATH: `${bin}:${process.env.PATH}` },
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(join(root, "output/unrelated"), "utf8"),
			"keep me\n",
		);
		for (const platform of ["linux-x64", "linux-arm64"]) {
			const archive = join(root, `output/pi-${platform}.tar.gz`);
			const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
			assert.equal(listing.status, 0, listing.stderr);
			for (const entry of [
				"pi/pi",
				"pi/license",
				"pi/ast-grep",
				"pi/scripts/telegram-service.py",
				"pi/skills/commit.md",
				`pi/native/linux/prebuilds/${platform}/helper`,
			]) {
				assert.ok(listing.stdout.split("\n").includes(entry), entry);
			}
			assert.equal(
				readFileSync(join(root, `output/${platform}/license`), "utf8"),
				readFileSync(join(root, "license"), "utf8"),
			);
		}
		assert.ok(existsSync(packageRoot));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const platform of ["darwin-x64", "windows-arm64", "linux-unknown"]) {
	test(`rejects unsupported ${platform} before installing or building`, () => {
		const result = spawnSync("bash", [script, "--platform", platform], {
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /expected linux-x64 or linux-arm64/);
	});
}
