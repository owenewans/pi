import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executable, nearest, packageRoot, run } from "./format-file.mjs";

export async function checkFiles(paths, { runner = run } = {}) {
	const before = new Map(await Promise.all(paths.map(async (path) => [path, await readFile(path)])));
	const assertCurrent = async () => {
		for (const [path, content] of before)
			if (!(await readFile(path)).equals(content))
				throw new Error(`check result is stale: concurrent change in ${path}`);
	};
	const checked = new Set();
	const messages = [];
	for (const path of paths) {
		const cwd = dirname(resolve(path)),
			ext = extname(path).toLowerCase();
		let command,
			args,
			root = cwd;
		const env = { ...process.env, GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", CARGO_NET_OFFLINE: "true" };
		if (ext === ".go") {
			const config = await nearest(path, ["go.mod"]);
			if (!config) throw new Error(`Go check unavailable: no go.mod for ${path}`);
			root = dirname(config);
			command = await executable("go", root);
			args = ["test", "-run=^$", "./..."];
		} else if (ext === ".rs") {
			const config = await nearest(path, ["Cargo.toml"]);
			if (!config) throw new Error(`Rust check unavailable: no Cargo.toml for ${path}`);
			root = dirname(config);
			command = await executable("cargo", root);
			args = ["check", "--offline", "--message-format=short"];
		} else if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
			const config = await nearest(path, ["tsconfig.json", "jsconfig.json"]);
			root = config ? dirname(config) : cwd;
			const local = await executable("tsc", root);
			command = local ?? process.execPath;
			const flags = config
				? ["--noEmit", "--project", config]
				: ["--noEmit", "--skipLibCheck", "--allowJs", "--checkJs", "--ignoreConfig", path];
			args = local ? flags : [join(packageRoot, "node_modules/typescript/bin/tsc"), ...flags];
		} else if (ext === ".py") {
			const config = await nearest(path, ["pyrightconfig.json", "pyproject.toml"]);
			root = config ? dirname(config) : cwd;
			command = process.execPath;
			args = [
				join(packageRoot, "node_modules/pyright/index.js"),
				"--outputjson",
				...(config ? ["--project", root] : [path]),
			];
		} else if ([".c", ".cc", ".cpp", ".cxx"].includes(ext)) {
			const database = await nearest(path, ["compile_commands.json"]);
			const entries = database ? JSON.parse(await readFile(database, "utf8")) : [];
			const entry = entries.find((item) => resolve(item.directory, item.file) === resolve(path));
			if (entry) {
				if (!Array.isArray(entry.arguments))
					throw new Error(`C/C++ check unavailable: compile command has no argv for ${path}`);
				command = entry.arguments[0];
				root = entry.directory;
				args = [];
				for (let i = 1; i < entry.arguments.length; i++) {
					const arg = entry.arguments[i];
					if (["-o", "-MF", "-MT", "-MQ"].includes(arg)) {
						i++;
						continue;
					}
					if (["-c", "-MD", "-MMD", "-MP"].includes(arg)) continue;
					args.push(arg);
				}
				args.push("-fsyntax-only");
			} else {
				command = await executable(ext === ".c" ? "clang" : "clang++", cwd);
				args = ["-fsyntax-only", path];
			}
		} else if ([".h", ".hpp", ".json", ".jsonc"].includes(ext)) {
			messages.push(`formatted ${path}; semantic checks belong to its translation unit or project`);
			continue;
		} else if (ext === ".sh") {
			command = await executable("shellcheck", cwd);
			if (command) args = [path];
			else {
				command = "/bin/sh";
				args = ["-n", path];
			}
		} else if (ext === ".zig") {
			command = await executable("zig", cwd);
			args = ["ast-check", path];
		} else throw new Error(`checker not configured for ${path}`);
		if (!command) throw new Error(`checker unavailable for ${path}`);
		const key = JSON.stringify([command, args, root]);
		if (checked.has(key)) continue;
		checked.add(key);
		const result = await runner(command, args, { cwd: root, env, timeout: 30000 });
		await assertCurrent();
		let output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		if (ext === ".py") {
			try {
				const report = JSON.parse(result.stdout);
				output = report.generalDiagnostics
					.map(
						(item) =>
							`${item.file}:${item.range.start.line + 1}:${item.range.start.character + 1}: ${item.severity}: ${item.message}`,
					)
					.join("\n");
			} catch {}
		}
		if (result.code !== 0) throw new Error(output || `checker exited ${result.code}`);
		messages.push(`checked ${root}`);
	}
	await assertCurrent();
	return messages;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		for (const message of await checkFiles(process.argv.slice(2))) console.log(message);
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
