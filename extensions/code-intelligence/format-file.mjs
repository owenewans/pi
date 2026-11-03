import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const packageRoot = dirname(fileURLToPath(import.meta.url));

export async function executable(name, start) {
	const paths = [];
	for (let dir = start; ; dir = dirname(dir)) {
		paths.push(join(dir, "node_modules/.bin", name));
		if (dirname(dir) === dir) break;
	}
	paths.push(...(process.env.PATH ?? "").split(":").map((dir) => join(dir, name)));
	for (const path of paths) {
		try {
			await access(path, constants.X_OK);
			return path;
		} catch {}
	}
	return undefined;
}

export async function nearest(file, names) {
	for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
		for (const name of names) {
			try {
				await access(join(dir, name));
				return join(dir, name);
			} catch {}
		}
		if (dirname(dir) === dir) return undefined;
		try {
			await access(join(dir, ".git"));
			return undefined;
		} catch {}
	}
}

export function run(command, args, { cwd, input, timeout = 20000, env = process.env } = {}) {
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const output = { stdout: "", stderr: "" };
		let error;
		const timer = setTimeout(() => {
			error = new Error(`${command}: timed out after ${timeout}ms`);
			child.kill("SIGTERM");
		}, timeout);
		const kill = setTimeout(() => child.kill("SIGKILL"), timeout + 1000);
		for (const stream of ["stdout", "stderr"])
			child[stream].setEncoding("utf8").on("data", (data) => {
				output[stream] += data;
				if (output.stdout.length + output.stderr.length > 2 * 1024 * 1024) {
					error = new Error("command output exceeds 2 MiB");
					child.kill();
				}
			});
		child.on("error", (cause) => {
			error = cause;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(kill);
			if (error) reject(error);
			else resolveResult({ ...output, code });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

export async function formatFile(inputPath, { biomeConfig, runner = run } = {}) {
	const path = await realpath(inputPath);
	const original = await readFile(path);
	const mode = (await stat(path)).mode;
	const cwd = dirname(path),
		ext = extname(path).toLowerCase();
	let command, args;
	let formatterCwd = cwd;
	if ([".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".sh", ".zig"].includes(ext)) {
		const tool =
			ext === ".go"
				? "gofmt"
				: ext === ".rs"
					? "rustfmt"
					: ext === ".sh"
						? "shfmt"
						: ext === ".zig"
							? "zig"
							: "clang-format";
		command = await executable(tool, cwd);
		if (!command) throw new Error(`formatter unavailable: ${tool} (${path})`);
		if (ext === ".rs") {
			const cargo = await nearest(path, ["Cargo.toml"]);
			const manifest = cargo ? await readFile(cargo, "utf8") : "";
			const edition = manifest.match(/^\s*edition\s*=\s*["'](2015|2018|2021|2024)["']/m)?.[1] ?? "2021";
			args = ["--emit", "stdout", "--edition", edition, "--config", "skip_children=true"];
		} else if (ext === ".go") args = [];
		else if (ext === ".sh") args = ["-filename", path];
		else if (ext === ".zig") args = ["fmt", "--stdin"];
		else args = ["--assume-filename", path];
	} else if (ext === ".py") {
		command = (await executable("ruff", cwd)) ?? join(packageRoot, "tools/ruff");
		args = ["format", "--stdin-filename", path, "-"];
	} else if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".jsonc"].includes(ext)) {
		const config = biomeConfig ?? (await nearest(path, ["biome.json", "biome.jsonc", "scripts/biome.config.json"]));
		command = config ? await executable("biome", cwd) : undefined;
		if (config && !command) throw new Error(`formatter unavailable: biome (${config})`);
		if (command) {
			formatterCwd = config.endsWith("/scripts/biome.config.json") ? dirname(dirname(config)) : dirname(config);
			args = ["format", "--stdin-file-path", path, "--config-path", config];
		} else {
			command = process.execPath;
			const prettier =
				(await executable("prettier", cwd)) ?? join(packageRoot, "node_modules/prettier/bin/prettier.cjs");
			args = [prettier, "--stdin-filepath", path];
		}
	} else throw new Error(`formatter not configured for ${path}`);
	const result = await runner(command, args, { cwd: formatterCwd, input: original });
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `formatter exited ${result.code}`);
	const formatted = Buffer.from(result.stdout);
	if (formatted.length === 0 && original.toString("utf8").trim())
		throw new Error(`formatter returned empty output for ${path}`);
	if (formatted.equals(original)) return false;
	const temp = join(cwd, `.${path.split("/").at(-1)}.pi-format-${randomUUID()}`);
	try {
		await writeFile(temp, formatted, { mode, flag: "wx" });
		await chmod(temp, mode);
		if (!(await readFile(path)).equals(original)) throw new Error(`formatting refused: concurrent change in ${path}`);
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => {});
	}
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const paths = process.argv.slice(2);
	let biomeConfig;
	if (paths[0] === "--biome-config") {
		paths.shift();
		biomeConfig = paths.shift();
	}
	let failed = false;
	for (const path of paths) {
		try {
			if (await formatFile(path, { biomeConfig })) console.log(`formatted ${path}`);
		} catch (error) {
			failed = true;
			console.error(String(error));
		}
	}
	if (paths.length === 0 || failed) process.exitCode = 1;
}
