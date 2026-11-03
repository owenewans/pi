import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const hash = async (path) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
async function sources(root) {
	const manifest = JSON.parse(await readFile(join(root, "patches/manifest.json"), "utf8"));
	for (const entry of manifest) {
		const installed = JSON.parse(await readFile(join(root, "node_modules", entry.name, "package.json"), "utf8"));
		if (installed.version !== entry.version)
			throw new Error(`${entry.name}: expected ${entry.version}, found ${installed.version}`);
	}
	return manifest;
}

export async function verifyPatches(root = packageRoot) {
	for (const entry of await sources(root)) {
		for (const file of entry.files) {
			if ((await hash(join(root, "node_modules", entry.name, file.path))) !== file.after) {
				throw new Error(`${entry.name}: patched source mismatch; run npm run setup in ${root}`);
			}
		}
	}
}

export async function applyPatches(root = packageRoot) {
	for (const entry of await sources(root)) {
		const directory = join(root, "node_modules", entry.name);
		const states = await Promise.all(entry.files.map((file) => hash(join(directory, file.path))));
		if (states.every((state, i) => state === entry.files[i].after)) continue;
		if (!states.every((state, i) => state === entry.files[i].before))
			throw new Error(`${entry.name}: source differs from both pinned upstream and patched revision`);
		const args = [
			"--batch",
			"--forward",
			"--silent",
			"-p1",
			"--directory",
			root,
			"--input",
			join(root, "patches", entry.patch),
		];
		const check = spawnSync("patch", ["--dry-run", ...args], { encoding: "utf8" });
		if (check.status !== 0) throw new Error(`${entry.name}: patch check failed\n${check.stdout}${check.stderr}`);
		const result = spawnSync("patch", args, { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`${entry.name}: patch failed\n${result.stdout}${result.stderr}`);
	}
	await verifyPatches(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await applyPatches();
	console.log("Pinned code intelligence patches verified.");
}
