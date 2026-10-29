import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteRemote, remotePosixCommand, runSsh } from "../src/extensions/ssh/client.ts";
import { writeRemote } from "../src/extensions/ssh/index.ts";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-ssh-"));
	vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH}`);
	const argsPath = join(directory, "ssh-args.json");
	writeFileSync(
		join(directory, "ssh"),
		`#!${process.execPath}\nconst fs = require('node:fs'); const { spawnSync } = require('node:child_process'); const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args)); const result = spawnSync('/bin/sh', ['-c', args[args.length - 1]], { input: fs.readFileSync(0) }); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 255);\n`,
		{ mode: 0o700 },
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("OpenSSH transport", () => {
	it("uses argument arrays, batch mode and the configured port", async () => {
		const result = await runSsh({ host: "user@alias", port: 2200 }, "printf fixture; printf error >&2; exit 7");
		expect(result).toEqual({ stdout: "fixture", stderr: "error", code: 7 });
		expect(JSON.parse(readFileSync(join(directory, "ssh-args.json"), "utf8"))).toEqual([
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=15",
			"-p",
			"2200",
			"--",
			"user@alias",
			remotePosixCommand("printf fixture; printf error >&2; exit 7"),
		]);
	});

	it.each(["-oProxyCommand=bad", "host name", "host\nname", "host\0name"])(
		"rejects host option injection: %j",
		async (host) => {
			await expect(runSsh({ host }, "true")).rejects.toThrow("SSH host");
		},
	);

	it("quotes remote shell arguments", async () => {
		const value = "a'b $(printf unsafe) ; & \"";
		const result = await runSsh({ host: "fixture" }, `printf %s ${quoteRemote(value)}`);
		expect(result.stdout).toBe(value);
	});

	it("forwards input bytes without interpolating them in a command", async () => {
		const content = "$(printf do-not-execute)\n'quoted'\n";
		const result = await runSsh({ host: "fixture" }, "cat", { input: content });
		expect(result.stdout).toBe(content);
	});

	it("honors pre-cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(runSsh({ host: "fixture" }, "true", { signal: controller.signal })).rejects.toThrow("cancelled");
	});

	it("terminates commands on timeout", async () => {
		await expect(runSsh({ host: "fixture" }, "sleep 60", { timeoutMs: 100 })).rejects.toThrow("timed out");
	});

	it("writes atomically with private defaults and preserves existing permissions", async () => {
		const path = join(directory, "file 'quoted'.txt");
		await writeRemote({ host: "fixture" }, path, "first");
		expect(readFileSync(path, "utf8")).toBe("first");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		chmodSync(path, 0o640);
		await writeRemote({ host: "fixture" }, path, "second");
		expect(readFileSync(path, "utf8")).toBe("second");
		expect(statSync(path).mode & 0o777).toBe(0o640);
		expect(readdirSync(directory).some((name) => name.startsWith(".pi-write."))).toBe(false);
	});

	it("refuses stale writes and cleans temporary files", async () => {
		const path = join(directory, "stale.txt");
		writeFileSync(path, "changed");
		await expect(writeRemote({ host: "fixture" }, path, "replacement", undefined, "0".repeat(64))).rejects.toThrow(
			"changed during edit",
		);
		expect(readFileSync(path, "utf8")).toBe("changed");
		expect(readdirSync(directory).some((name) => name.startsWith(".pi-write."))).toBe(false);
	});
});
