// owns SSH forwarding processes and closes them when the session ends.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { type SshTarget, sshArguments } from "./client.ts";

export type TunnelOptions = SshTarget & {
	type: "local" | "remote" | "dynamic";
	bindHost?: string;
	bindPort: number;
	destinationHost?: string;
	destinationPort?: number;
};
export type TunnelInfo = TunnelOptions & { id: string; state: "running" | "closed"; code?: number };
type OwnedTunnel = { info: TunnelInfo; child: ChildProcessWithoutNullStreams; done: Promise<void>; directory: string };

/** Own forwarding processes for one session without changing the user's SSH configuration. */
export class SshTunnels {
	private readonly tunnels = new Map<string, OwnedTunnel>();
	private readonly opening = new Map<Promise<TunnelInfo>, AbortController>();
	private closed = false;

	/** Open a forwarding and wait until OpenSSH's control socket confirms startup. */
	open(options: TunnelOptions, signal?: AbortSignal): Promise<TunnelInfo> {
		if (this.closed) return Promise.reject(new Error("SSH tunnel owner is closed"));
		const controller = new AbortController();
		const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const task = this.start(options, active).finally(() => this.opening.delete(task));
		this.opening.set(task, controller);
		return task;
	}

	private async start(options: TunnelOptions, signal: AbortSignal): Promise<TunnelInfo> {
		signal?.throwIfAborted();
		const forward = forwardSpecification(options);
		const args = sshArguments(options);
		const directory = await mkdtemp(join(tmpdir(), "pi-ssh-tunnel-"));
		const control = join(directory, "control");
		args.splice(
			args.length - 2,
			0,
			"-N",
			"-M",
			"-S",
			control,
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"ServerAliveInterval=15",
			options.type === "local" ? "-L" : options.type === "remote" ? "-R" : "-D",
			forward,
		);
		const child = spawn("ssh", args, { stdio: "pipe", detached: true, env: getShellEnv() });
		const info: TunnelInfo = {
			...options,
			bindHost: options.bindHost ?? "127.0.0.1",
			id: `ssh_${randomUUID().slice(0, 8)}`,
			state: "running",
		};
		let failure: Error | undefined;
		let diagnostics = "";
		const done = new Promise<void>((resolve) => {
			child.once("spawn", () => {
				if (child.pid) trackDetachedChildPid(child.pid);
			});
			child.once("error", () => {
				failure = new Error("Could not start SSH tunnel");
			});
			child.stdout.resume();
			child.stdin.on("error", () => {});
			child.stdin.end();
			child.stderr.on("data", (chunk: Buffer) => {
				if (diagnostics.length < 16_384) diagnostics += chunk.toString("utf8");
			});
			child.once("close", (code) => {
				if (child.pid) untrackDetachedChildPid(child.pid);
				info.state = "closed";
				info.code = code ?? 255;
				if (code !== 0) failure ??= new Error(`SSH tunnel failed: ${diagnostics.trim() || `exit ${code}`}`);
				resolve();
			});
		});
		const tunnel: OwnedTunnel = { child, info, done, directory };
		const abort = () => {
			if (child.pid) killProcessTree(child.pid);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for (let attempt = 0; attempt < 150; attempt++) {
				signal?.throwIfAborted();
				if (failure || info.state === "closed") throw failure ?? new Error("SSH tunnel exited before startup");
				if (await checkControl(options, control)) {
					this.tunnels.set(info.id, tunnel);
					return { ...info };
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error("SSH tunnel startup timed out");
		} catch (error) {
			abort();
			await done;
			await rm(directory, { recursive: true, force: true });
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	/** List this session's forwardings, including those that have exited. */
	list(): TunnelInfo[] {
		return [...this.tunnels.values()].map(({ info }) => ({ ...info }));
	}

	/** Stop an owned forwarding and remove its control socket. */
	async close(id: string): Promise<void> {
		const tunnel = this.tunnels.get(id);
		if (!tunnel) throw new Error("Unknown SSH tunnel id");
		if (tunnel.info.state === "running" && tunnel.child.pid) killProcessTree(tunnel.child.pid);
		await tunnel.done;
		await rm(tunnel.directory, { recursive: true, force: true });
		this.tunnels.delete(id);
	}

	/** Stop all forwardings owned by this session. */
	async closeAll(): Promise<void> {
		this.closed = true;
		for (const controller of this.opening.values()) controller.abort();
		await Promise.allSettled(this.opening.keys());
		await Promise.all([...this.tunnels.keys()].map((id) => this.close(id)));
	}
}

function forwardSpecification(options: TunnelOptions): string {
	for (const value of [
		options.bindHost ?? "127.0.0.1",
		...(options.type === "dynamic" ? [] : [options.destinationHost ?? ""]),
	]) {
		if (!value || /[\s\x00-\x1f\x7f[\]]/.test(value) || value.startsWith("-"))
			throw new Error("Invalid SSH forwarding host");
	}
	for (const port of [options.bindPort, ...(options.type === "dynamic" ? [] : [options.destinationPort])]) {
		if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535)
			throw new Error("SSH forwarding ports must be between 1 and 65535");
	}
	const host = (value: string) => (value.includes(":") ? `[${value}]` : value);
	const binding = `${host(options.bindHost ?? "127.0.0.1")}:${options.bindPort}`;
	return options.type === "dynamic"
		? binding
		: `${binding}:${host(options.destinationHost!)}:${options.destinationPort}`;
}

function checkControl(target: SshTarget, control: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("ssh", sshArguments(target, ["-S", control, "-O", "check"]), {
			stdio: "ignore",
			env: getShellEnv(),
		});
		const timer = setTimeout(() => child.kill(), 1000);
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}
