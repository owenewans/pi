// exercises the debugger against a real disposable C program.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Debugger } from "../src/extensions/code/debugger.ts";

const debuggerSession = new Debugger();
const directories: string[] = [];
afterEach(async () => {
	await debuggerSession.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("starts a real program, stops at a breakpoint and evaluates a value", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-debugger-"));
	directories.push(directory);
	const source = join(directory, "main.c");
	const binary = join(directory, "main");
	writeFileSync(source, "int main(void) { volatile int value = 42; return value - 42; }\n");
	const build = spawnSync("cc", ["-g", "-O0", source, "-o", binary], { encoding: "utf8" });
	expect(build.status, build.stderr).toBe(0);
	await debuggerSession.start(binary, [], directory);
	expect(await debuggerSession.command("-break-insert main")).toContain("^done");
	expect(await debuggerSession.command("-exec-run")).toContain("^running");
	let output = "";
	for (let i = 0; i < 100 && !output.includes("*stopped"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		output += debuggerSession.read().join("\n");
	}
	expect(output).toContain('reason="breakpoint-hit"');
	expect(await debuggerSession.command("-data-evaluate-expression 2+2")).toContain('value="4"');
	await expect(debuggerSession.command("-unknown-command")).rejects.toThrow();
}, 30_000);

it("stops a running inferior when the debugger closes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-debugger-running-"));
	directories.push(directory);
	const source = join(directory, "sleep.c");
	const binary = join(directory, "sleep");
	writeFileSync(source, "#include <unistd.h>\nint main(void) { sleep(60); return 0; }\n");
	const build = spawnSync("cc", ["-g", source, "-o", binary], { encoding: "utf8" });
	expect(build.status, build.stderr).toBe(0);
	await debuggerSession.start(binary, [], directory);
	await debuggerSession.command("-exec-run");
	const groups = await debuggerSession.command("-list-thread-groups");
	const pid = Number(/pid="(\d+)"/.exec(groups)?.[1]);
	expect(pid).toBeGreaterThan(1);
	await Promise.all([debuggerSession.close(), debuggerSession.close()]);
	expect(() => process.kill(pid, 0)).toThrow();
	await debuggerSession.start(binary, [], directory);
	expect(await debuggerSession.command("-gdb-show mi-async")).toContain('value="on"');
}, 30_000);
