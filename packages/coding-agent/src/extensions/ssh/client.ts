// executes remote commands through the user's OpenSSH configuration.
import { spawn } from "node:child_process";
import { getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

export type SshTarget = { host: string; port?: number };
export type SshResult = { stdout: string; stderr: string; code: number };

/** Quotes an argument for a POSIX remote shell without interpreting its contents. */
export function quoteRemote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Enter POSIX sh through either a POSIX or fish account shell without expanding the command there. */
export function remotePosixCommand(command: string): string {
	return `sh -c "${command.replace(/[\\"$`]/g, "\\$&")}"`;
}

/** Build noninteractive OpenSSH arguments while preserving user aliases, keys and jump hosts. */
export function sshArguments(target: SshTarget, options: readonly string[] = []): string[] {
	// tool arguments cross the model-input boundary; host must not become an SSH option.
	if (!target.host || target.host.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(target.host))
		throw new Error("SSH host must be a hostname, user@host or SSH config alias");
	if (target.port !== undefined && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535))
		throw new Error("Invalid SSH port");
	const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
	if (target.port !== undefined) args.push("-p", String(target.port));
	return [...args, ...options, "--", target.host];
}

/** Run a cancellable POSIX command without prompts or a local shell. */
export async function runSsh(
	target: SshTarget,
	command: string,
	options: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SshResult> {
	options.signal?.throwIfAborted();
	const args = [...sshArguments(target), remotePosixCommand(command)];
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", args, { stdio: "pipe", detached: true, env: getShellEnv() });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			if (child.pid) killProcessTree(child.pid);
		};
		const abort = () => stop(new Error("SSH operation cancelled"));
		const timeout = setTimeout(() => stop(new Error("SSH operation timed out")), options.timeoutMs ?? 60_000);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.once("spawn", () => {
			if (child.pid) trackDetachedChildPid(child.pid);
		});
		child.once("error", () => stop(new Error("Could not start OpenSSH")));
		child.stdin.on("error", () => {});
		for (const [stream, chunks] of [
			[child.stdout, stdout],
			[child.stderr, stderr],
		] as const) {
			stream.on("data", (data: Buffer) => {
				bytes += data.length;
				if (bytes > 10 * 1024 * 1024) stop(new Error("SSH output exceeded 10 MiB; narrow the command"));
				else chunks.push(data);
			});
		}
		child.once("close", (code) => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (failure) reject(failure);
			else
				resolve({
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					code: code ?? 255,
				});
		});
		child.stdin.end(options.input);
	});
}
