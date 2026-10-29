import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProcessInfo, ProcessManager } from "../src/extensions/processes/manager.ts";

let directory: string;
let manager: ProcessManager;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-process-manager-"));
	manager = new ProcessManager(directory);
});
afterEach(async () => {
	await manager.dispose();
	rmSync(directory, { recursive: true, force: true });
});

describe("background process manager", () => {
	it("runs commands and stores private complete output", async () => {
		const exited = Promise.withResolvers<ProcessInfo>();
		const info = await manager.start(
			"fixture",
			"printf stdout; printf stderr >&2",
			directory,
			"pipe",
			exited.resolve,
		);
		await exited.promise;
		expect(info.state).toEqual({ kind: "exited", code: 0, signal: null });
		expect(manager.output(info.id)).toContain("stdout");
		expect(manager.output(info.id)).toContain("stderr");
		expect(readFileSync(info.logPath, "utf8")).toContain("stdout");
		expect(statSync(info.logPath).mode & 0o777).toBe(0o600);
	});

	it("allocates a real PTY and accepts terminal input", async () => {
		const exited = Promise.withResolvers<ProcessInfo>();
		const info = await manager.start(
			"pty",
			'test -t 0 && test -t 1 && printf "real-pty\\n"; read -r value; printf "input=%s\\n" "$value"',
			directory,
			"pty",
			exited.resolve,
		);
		await manager.write(info.id, "fixture-input\n", false);
		await exited.promise;
		expect(info.state).toEqual({ kind: "exited", code: 0, signal: null });
		expect(manager.output(info.id)).toContain("real-pty");
		expect(manager.output(info.id)).toContain("input=fixture-input");
	});

	it("bounds recent output without truncating its log", async () => {
		const exited = Promise.withResolvers<ProcessInfo>();
		const info = await manager.start(
			"output",
			"head -c 100000 /dev/zero | tr '\\0' x",
			directory,
			"pipe",
			exited.resolve,
		);
		await exited.promise;
		expect(manager.output(info.id)).toHaveLength(65_536);
		expect(statSync(info.logPath).size).toBe(100_000);
	});

	it("reports nonzero exit codes", async () => {
		const exited = Promise.withResolvers<ProcessInfo>();
		const info = await manager.start("failure", "exit 7", directory, "pipe", exited.resolve);
		await exited.promise;
		expect(info.state).toEqual({ kind: "exited", code: 7, signal: null });
	});

	it("writes to a pipe and closes stdin", async () => {
		const exited = Promise.withResolvers<ProcessInfo>();
		const info = await manager.start("cat", "cat", directory, "pipe", exited.resolve);
		await manager.write(info.id, "fixture", true);
		await exited.promise;
		expect(manager.output(info.id)).toBe("fixture");
	});

	it.each(["pipe", "pty"] as const)("stops %s commands and their foreground child", async (terminal) => {
		const info = await manager.start(
			"sleep",
			'sleep 60 & child=$!; printf "%s\\n" "$child"; wait "$child"',
			directory,
			terminal,
			() => {},
		);
		await vi.waitFor(() => expect(manager.output(info.id)).toMatch(/\d+/));
		const pid = Number(/\d+/.exec(manager.output(info.id))?.[0]);
		await manager.stop(info.id);
		expect(info.state.kind).toBe("stopped");
		await vi.waitFor(() => {
			try {
				const status = readFileSync(`/proc/${pid}/stat`, "utf8");
				expect(status.split(" ")[2]).toBe("Z");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		});
	});

	it("clears completed entries without stopping live ones", async () => {
		const exited = Promise.withResolvers<ProcessInfo>();
		const completed = await manager.start("done", "printf done", directory, "pipe", exited.resolve);
		await exited.promise;
		const live = await manager.start("live", "sleep 60", directory, "pipe", () => {});
		manager.clear();
		expect(manager.list().map((info) => info.id)).toEqual([live.id]);
		expect(() => manager.output(completed.id)).toThrow("Unknown process");
	});

	it("rejects writes to a completed process", async () => {
		const exited = Promise.withResolvers<ProcessInfo>();
		const info = await manager.start("done", "true", directory, "pipe", exited.resolve);
		await exited.promise;
		await expect(manager.write(info.id, "input", false)).rejects.toThrow("not running");
	});
});
