// speaks framed JSON-RPC with an owned language-server process.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { JsonValue } from "@earendil-works/pi-ai";

export type LspNotification = { method: string; params?: JsonValue };
type Pending = { resolve(value: JsonValue): void; reject(error: Error): void; cleanup(): void };

/** Own one language-server process and bound all requests, frames and cancellation listeners. */
export class LspRpc {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, Pending>();
	private sequence = 0;
	private buffer = Buffer.alloc(0);
	private ended = false;
	private readonly done: Promise<void>;
	private readonly notification: (message: LspNotification) => void;
	private readonly configuration: (method: string, params: JsonValue | undefined) => JsonValue;

	constructor(
		command: string[],
		cwd: string,
		notification: (message: LspNotification) => void,
		configuration: (method: string, params: JsonValue | undefined) => JsonValue,
	) {
		this.notification = notification;
		this.configuration = configuration;
		const env: NodeJS.ProcessEnv = {};
		for (const name of [
			"PATH",
			"HOME",
			"LANG",
			"LC_ALL",
			"XDG_CACHE_HOME",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"RUSTUP_HOME",
			"CARGO_HOME",
			"GOPATH",
			"GOROOT",
			"CC",
			"CXX",
		])
			if (process.env[name] !== undefined) env[name] = process.env[name];
		this.child = spawn(command[0], command.slice(1), { cwd, env, stdio: "pipe" });
		this.child.stdout.on("data", (chunk: Buffer) => {
			try {
				this.receive(chunk);
			} catch {
				this.fail(new Error("Language server returned an invalid or oversized JSON-RPC frame"));
				this.child.kill();
			}
		});
		this.child.stderr.resume();
		this.child.stdin.on("error", () => {});
		this.child.once("error", () =>
			this.fail(new Error("Could not start language server; install it or configure its command")),
		);
		this.done = new Promise((resolve) =>
			this.child.once("close", (code) => {
				this.fail(new Error(`Language server exited (${code ?? "signal"})`));
				resolve();
			}),
		);
	}

	/** Send a request and cancel it on abort or deadline, never leaving listeners behind. */
	request(method: string, params: JsonValue, signal?: AbortSignal, timeoutMs = 15_000): Promise<JsonValue> {
		signal?.throwIfAborted();
		if (this.ended) return Promise.reject(new Error("Language server is closed"));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const cancel = (error: Error) => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				pending.cleanup();
				this.notify("$/cancelRequest", { id });
				reject(error);
			};
			const abort = () => cancel(new Error("Language-server request cancelled"));
			const timer = setTimeout(() => cancel(new Error(`Language-server ${method} timed out`)), timeoutMs);
			this.pending.set(id, {
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
				},
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Send an LSP notification unless the process already ended. */
	notify(method: string, params: JsonValue): void {
		if (!this.ended) this.send({ jsonrpc: "2.0", method, params });
	}

	/** Stop the owned language server even if it ignores protocol shutdown. */
	async close(): Promise<void> {
		if (this.ended) {
			await this.done;
			return;
		}
		try {
			await this.request("shutdown", null, undefined, 1000);
		} catch {}
		this.notify("exit", null);
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		try {
			await this.done;
		} finally {
			clearTimeout(timer);
		}
	}

	private send(message: JsonValue): void {
		const bytes = Buffer.from(JSON.stringify(message));
		this.child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`);
		this.child.stdin.write(bytes);
	}

	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > 8 * 1024 * 1024) throw new Error("Frame exceeds limit");
		for (;;) {
			const end = this.buffer.indexOf("\r\n\r\n");
			if (end < 0) {
				if (this.buffer.length > 8192) throw new Error("Header exceeds limit");
				return;
			}
			const length = Number(
				/^Content-Length:\s*(\d+)\s*$/im.exec(this.buffer.subarray(0, end).toString("ascii"))?.[1],
			);
			if (!Number.isInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw new Error("Invalid length");
			if (this.buffer.length < end + 4 + length) return;
			let raw: unknown;
			try {
				raw = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
			} catch {
				throw new Error("Malformed language-server JSON");
			}
			this.buffer = this.buffer.subarray(end + 4 + length);
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid message");
			// SAFETY: JSON.parse guarantees JSON values; the object boundary was checked above.
			const message = raw as Record<string, JsonValue>;
			if (typeof message.method === "string") {
				if (typeof message.id === "number" || typeof message.id === "string") {
					this.send({
						jsonrpc: "2.0",
						id: message.id,
						result: this.configuration(message.method, message.params),
					});
				} else this.notification({ method: message.method, params: message.params });
				continue;
			}
			if (typeof message.id !== "number") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			this.pending.delete(message.id);
			pending.cleanup();
			if (message.error) {
				const error = message.error;
				const text =
					typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
						? error.message
						: "Language-server request failed";
				pending.reject(new Error(text));
			} else pending.resolve(message.result ?? null);
		}
	}

	private fail(error: Error): void {
		this.ended = true;
		for (const pending of this.pending.values()) {
			pending.cleanup();
			pending.reject(error);
		}
		this.pending.clear();
	}
}
