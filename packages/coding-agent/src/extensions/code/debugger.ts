// owns one gdb machine-interface process and its inferior for an agent session.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const OUTPUT_LIMIT = 256 * 1024;
type Pending = { resolve(value: string): void; reject(error: Error): void };

/** Manage a persistent GDB session using machine-interface commands. */
export class Debugger {
	private child: ChildProcessWithoutNullStreams | undefined;
	private pending = new Map<number, Pending>();
	private sequence = 0;
	private lines: string[] = [];
	private bytes = 0;
	private done: Promise<void> | undefined;
	private closing: Promise<void> | undefined;

	/** Start GDB with a target and literal argument vector. */
	async start(program: string, args: string[], cwd: string): Promise<void> {
		if (this.child || this.closing) throw new Error("Debugger already running or closing");
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TERM"])
			if (process.env[key] !== undefined) env[key] = process.env[key];
		env.DEBUGINFOD_URLS = "";
		const child = spawn("gdb", ["--quiet", "--nx", "--interpreter=mi2", "--args", program, ...args], {
			cwd,
			env,
			stdio: "pipe",
			detached: true,
		});
		this.child = child;
		this.lines = [];
		this.bytes = 0;
		createInterface({ input: child.stdout }).on("line", (line) => {
			if (this.child === child) this.receive(line);
		});
		createInterface({ input: child.stderr }).on("line", (line) => {
			if (this.child === child) this.receive(`stderr: ${line}`);
		});
		child.stdin.on("error", () => {});
		child.once("error", () => this.fail(child, new Error("Could not start gdb")));
		this.done = new Promise((resolve) =>
			child.once("close", () => {
				this.fail(child, new Error("Debugger exited"));
				resolve();
			}),
		);
		try {
			await this.command("-gdb-set pagination off");
			await this.command("-gdb-set confirm off");
			await this.command("-gdb-set mi-async on");
		} catch (error) {
			if (this.child === child) await this.close();
			throw error;
		}
	}

	/** Send one machine-interface command, returning its result record. */
	command(command: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (!this.child) return Promise.reject(new Error("Debugger is not running"));
		if (!/^-[a-z][a-z0-9-]*(?:\s[^\r\n]*)?$/.test(command))
			return Promise.reject(new Error("Expected one GDB machine-interface command"));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const abort = () => finish(new Error("Debugger command cancelled"));
			const timer = setTimeout(() => finish(new Error("Debugger command timed out")), 30_000);
			const finish = (error?: Error, value?: string) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve(value ?? "");
			};
			this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) return abort();
			this.child?.stdin.write(`${id}${command}\n`);
		});
	}

	/** Return and clear asynchronous events and target output. */
	read(): string[] {
		const result = this.lines;
		this.lines = [];
		this.bytes = 0;
		return result;
	}

	/** Stop the inferior and debugger, then force cleanup if GDB does not exit. */
	async close(): Promise<void> {
		if (this.closing) return this.closing;
		const child = this.child;
		if (!child) return;
		const done = this.done;
		const closing = (async () => {
			const timer = setTimeout(() => {
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {}
				}
			}, 1000);
			try {
				await this.command("-gdb-exit").catch(() => {});
				await done;
			} finally {
				clearTimeout(timer);
				this.fail(child, new Error("Debugger closed"));
			}
		})();
		this.closing = closing;
		try {
			await closing;
		} finally {
			if (this.closing === closing) this.closing = undefined;
		}
	}

	private receive(line: string): void {
		const result = /^(\d+)\^(done|running|connected|exit|error)(?:,|$)/.exec(line);
		if (result) {
			const pending = this.pending.get(Number(result[1]));
			if (pending) {
				if (result[2] === "error") pending.reject(new Error(line));
				else pending.resolve(line);
			}
			return;
		}
		if (line === "(gdb) ") return;
		const size = Buffer.byteLength(line);
		if (size > OUTPUT_LIMIT) line = `${line.slice(0, OUTPUT_LIMIT / 4)} [truncated]`;
		this.lines.push(line);
		this.bytes += Buffer.byteLength(line);
		while (this.bytes > OUTPUT_LIMIT && this.lines.length > 1)
			this.bytes -= Buffer.byteLength(this.lines.shift() ?? "");
	}

	private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.child = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}
}
