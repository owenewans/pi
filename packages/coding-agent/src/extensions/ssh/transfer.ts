// streams binary archives through OpenSSH and publishes staged copies without decoding file bytes.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { quoteRemote, remotePosixCommand, runSsh, type SshTarget, sshArguments } from "./client.ts";

export type TransferOptions = SshTarget & {
	direction: "upload" | "download";
	localPath: string;
	remotePath: string;
	recursive?: boolean;
	overwrite?: boolean;
	timeoutMs?: number;
};
export type TransferResult = { localPath: string; remotePath: string; archiveBytes: number };
const execFileAsync = promisify(execFile);

/** Copy a file or tree with binary streams, staged publication, cancellation and no-clobber defaults. */
export async function transferSsh(
	options: TransferOptions,
	cwd: string,
	signal?: AbortSignal,
): Promise<TransferResult> {
	const localPath = resolve(cwd, options.localPath);
	const remotePath = options.remotePath;
	if (!remotePath || remotePath.includes("\0") || ["", ".", ".."].includes(posix.basename(remotePath)))
		throw new Error("SSH transfer requires an exact remote file or directory path");
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
	const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
	active.throwIfAborted();
	if (options.direction === "upload") {
		const source = await lstat(localPath);
		if (source.isDirectory() && !options.recursive) throw new Error("Set recursive to transfer a directory");
		const name = basename(localPath);
		if (!name) throw new Error("Cannot transfer the filesystem root");
		const script = [
			"set -eu",
			"umask 077",
			`destination=${quoteRemote(remotePath)}`,
			`directory=${quoteRemote(posix.dirname(remotePath))}`,
			'mkdir -p -- "$directory"',
			'staging=$(mktemp -d "$directory/.pi-transfer.XXXXXX")',
			`trap 'rm -rf -- "$staging"' EXIT HUP INT TERM`,
			'tar --ignore-zeros --no-same-owner --no-same-permissions -xf - -C "$staging"',
			`source="$staging"/${quoteRemote(name)}`,
			options.overwrite
				? 'mv -Tf -- "$source" "$destination"'
				: 'mv -Tn -- "$source" "$destination"; if [ -e "$source" ] || [ -L "$source" ]; then echo "destination exists" >&2; exit 73; fi',
		].join("\n");
		const bytes = await streamArchive(
			["tar", "-C", dirname(localPath), "-cf", "-", "--", name],
			["ssh", ...sshArguments(options), remotePosixCommand(script)],
			active,
		);
		return { localPath, remotePath, archiveBytes: bytes };
	}
	const remoteKind = await runSsh(
		options,
		`if [ -d ${quoteRemote(remotePath)} ]; then printf directory; else printf file; fi`,
		{ signal: active },
	);
	if (remoteKind.code !== 0) throw new Error("Could not inspect remote transfer source");
	if (remoteKind.stdout === "directory" && !options.recursive)
		throw new Error("Set recursive to transfer a directory");
	await mkdir(dirname(localPath), { recursive: true });
	const staging = await mkdtemp(join(dirname(localPath), ".pi-transfer-"));
	const name = posix.basename(remotePath);
	try {
		const command = `tar -C ${quoteRemote(posix.dirname(remotePath))} -cf - -- ${quoteRemote(name)}`;
		const bytes = await streamArchive(
			["ssh", ...sshArguments(options), remotePosixCommand(command)],
			["tar", "--ignore-zeros", "--no-same-owner", "--no-same-permissions", "-xf", "-", "-C", staging],
			active,
		);
		const source = join(staging, name);
		await execFileAsync("mv", ["-T", options.overwrite ? "-f" : "-n", "--", source, localPath], {
			signal: active,
			timeout: 30_000,
			maxBuffer: 64 * 1024,
		});
		try {
			await lstat(source);
			throw new Error("SSH download destination exists");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		return { localPath, remotePath, archiveBytes: bytes };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

type TransferProcess = { child: ChildProcessWithoutNullStreams; done: Promise<void> };

async function streamArchive(sourceArgs: string[], destinationArgs: string[], signal: AbortSignal): Promise<number> {
	let source: TransferProcess | undefined;
	let destination: TransferProcess | undefined;
	try {
		source = spawnTransferProcess(sourceArgs, signal);
		destination = spawnTransferProcess(destinationArgs, signal);
		let bytes = 0;
		source.child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
		});
		source.child.stdin.end();
		destination.child.stdout.resume();
		await Promise.all([
			source.done,
			destination.done,
			pipeline(source.child.stdout, destination.child.stdin, { signal }),
		]);
		return bytes;
	} catch (error) {
		for (const process of [source, destination]) if (process?.child.pid) killProcessTree(process.child.pid);
		await Promise.allSettled([source?.done, destination?.done]);
		throw error;
	}
}

function spawnTransferProcess(command: string[], signal: AbortSignal): TransferProcess {
	signal.throwIfAborted();
	const [program, ...args] = command;
	const child = spawn(program, args, { stdio: "pipe", detached: true, env: getShellEnv() });
	let diagnostics = "";
	let failure: Error | undefined;
	const stop = () => {
		if (child.pid) killProcessTree(child.pid);
	};
	const abort = () => {
		failure = new Error("SSH transfer cancelled or timed out");
		stop();
	};
	const done = new Promise<void>((resolve, reject) => {
		child.once("spawn", () => {
			if (child.pid) trackDetachedChildPid(child.pid);
		});
		child.once("error", () => reject(new Error(`Could not start transfer program ${program}`)));
		child.stderr.on("data", (chunk: Buffer) => {
			if (diagnostics.length + chunk.length > 128 * 1024) {
				failure = new Error("Transfer diagnostics exceeded 128 KiB");
				stop();
			} else diagnostics += chunk.toString("utf8");
		});
		child.stdin.on("error", () => {});
		child.once("close", (code) => {
			signal.removeEventListener("abort", abort);
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(new Error(`SSH transfer ${program} failed: ${diagnostics.trim() || `exit ${code}`}`));
			else resolve();
		});
	});
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	return { child, done };
}
