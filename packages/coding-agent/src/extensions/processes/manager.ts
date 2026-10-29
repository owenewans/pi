// owns background processes and Linux PTYs for one agent session.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";

export type ProcessState =
	| { kind: "running" }
	| { kind: "stopping" }
	| { kind: "exited"; code: number | null; signal: NodeJS.Signals | null }
	| { kind: "failed"; message: string }
	| { kind: "stopped" };

export type ProcessInfo = {
	id: string;
	name: string;
	command: string;
	cwd: string;
	terminal: "pipe" | "pty";
	state: ProcessState;
	logPath: string;
	startedAt: number;
};

type ManagedProcess = {
	info: ProcessInfo;
	child: ChildProcessWithoutNullStreams;
	output: string;
	finished: Promise<void>;
};

/** Owns subprocess lifetimes and retains bounded recent output plus complete private logs. */
export class ProcessManager {
	private readonly directory: string;
	private readonly entries = new Map<string, ManagedProcess>();

	constructor(directory: string) {
		this.directory = directory;
	}

	/** Starts a shell command with pipes or a real util-linux pseudo-terminal. */
	async start(
		name: string,
		command: string,
		cwd: string,
		terminal: "pipe" | "pty",
		onExit: (info: ProcessInfo) => void,
	): Promise<ProcessInfo> {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const id = randomUUID();
		const logPath = join(this.directory, `${id}.log`);
		writeFileSync(logPath, "", { mode: 0o600, flag: "wx" });
		const shell = getShellConfig();
		const child =
			terminal === "pty"
				? spawn("script", ["--quiet", "--return", "--flush", "--command", command, "/dev/null"], {
						cwd,
						env: { ...getShellEnv(), SHELL: shell.shell, TERM: "xterm-256color" },
						detached: true,
						stdio: "pipe",
					})
				: spawn(shell.shell, [...shell.args, command], { cwd, env: getShellEnv(), detached: true, stdio: "pipe" });
		const info: ProcessInfo = {
			id,
			name,
			command,
			cwd,
			terminal,
			state: { kind: "running" },
			logPath,
			startedAt: Date.now(),
		};
		let finish: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const entry: ManagedProcess = { info, child, output: "", finished };
		this.entries.set(id, entry);
		const stdout = new StringDecoder("utf8");
		const stderr = new StringDecoder("utf8");
		const append = (text: string) => {
			if (!text) return;
			entry.output = (entry.output + text).slice(-65_536);
			try {
				appendFileSync(info.logPath, text, { mode: 0o600 });
			} catch {
				info.state = { kind: "failed", message: "Could not write process log" };
				if (child.pid) killProcessTree(child.pid);
			}
		};
		child.stdout.on("data", (data: Buffer) => append(stdout.write(data)));
		child.stderr.on("data", (data: Buffer) => append(stderr.write(data)));
		child.stdin.on("error", () => {});
		child.once("close", (code, signal) => {
			append(stdout.end());
			append(stderr.end());
			if (info.state.kind === "running") info.state = { kind: "exited", code, signal };
			else if (info.state.kind === "stopping") info.state = { kind: "stopped" };
			if (child.pid) untrackDetachedChildPid(child.pid);
			finish();
			onExit(info);
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", () => {
				if (child.pid) trackDetachedChildPid(child.pid);
				resolve();
			});
			child.once("error", () => {
				info.state = {
					kind: "failed",
					message:
						terminal === "pty"
							? "Could not start PTY; install util-linux script"
							: "Could not start shell command",
				};
				reject(new Error(info.state.message));
			});
		});
		return info;
	}

	/** Lists the processes owned by this session. */
	list(): ProcessInfo[] {
		return [...this.entries.values()].map((entry) => entry.info);
	}

	/** Reads bounded recent output; complete output remains in logPath. */
	output(id: string): string {
		return this.get(id).output;
	}

	/** Writes input without interpreting it or closes stdin after the write. */
	async write(id: string, input: string, end: boolean): Promise<void> {
		const { child, info } = this.get(id);
		if (info.state.kind !== "running") throw new Error("Process is not running");
		await new Promise<void>((resolve, reject) => {
			const done = (error?: Error | null) => (error ? reject(new Error("Process input is closed")) : resolve());
			if (end) child.stdin.end(input, done);
			else child.stdin.write(input, done);
		});
	}

	/** Stops the process; util-linux forwards TERM to the PTY's child session. */
	async stop(id: string): Promise<void> {
		const entry = this.get(id);
		if (entry.info.state.kind === "stopping") return entry.finished;
		if (entry.info.state.kind !== "running") return;
		entry.info.state = { kind: "stopping" };
		if (entry.info.terminal === "pty") entry.child.kill("SIGTERM");
		else if (entry.child.pid) killProcessTree(entry.child.pid);
		const timer = setTimeout(() => {
			if (entry.child.pid) killProcessTree(entry.child.pid);
		}, 2000);
		try {
			await entry.finished;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Clears only completed entries and their logs. */
	clear(): void {
		for (const [id, entry] of this.entries) {
			if (entry.info.state.kind === "running" || entry.info.state.kind === "stopping") continue;
			rmSync(entry.info.logPath, { force: true });
			this.entries.delete(id);
		}
	}

	/** Stops owned processes before the session is disposed. */
	async dispose(): Promise<void> {
		await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
	}

	private get(id: string): ManagedProcess {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown process: ${id}`);
		return entry;
	}
}
