// connects Playwright MCP to pi's native MCP client without a subprocess or SDK runtime client.
import { EventEmitter } from "node:events";
import { McpClient, McpConnectionClosedError, type McpTransport, parseJsonRpcMessage } from "@earendil-works/pi-mcp";
import type { Transport as SdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createConnection } from "@playwright/mcp";
import type { BrowserContext } from "playwright-core";

export type BrowserConnection = { client: McpClient; close(): Promise<void> };

/** Connect the complete Playwright tool catalog to an owned persistent context. */
export async function connectPlaywright(
	context: () => Promise<BrowserContext>,
	outputDir: string,
): Promise<BrowserConnection> {
	const events = new EventEmitter();
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		events.emit("close");
		serverTransport.onclose?.();
	};
	const serverTransport: SdkTransport = {
		start: async () => {},
		send: async (message) => {
			if (closed) throw new McpConnectionClosedError();
			const parsed = parseJsonRpcMessage(message);
			queueMicrotask(() => {
				if (!closed) events.emit("message", parsed);
			});
		},
		close,
	};
	const transport: McpTransport = {
		start: async () => {},
		send: async (message, options) => {
			options?.signal?.throwIfAborted();
			if (closed) throw new McpConnectionClosedError();
			// SAFETY: both transports carry MCP JSON-RPC; the native client never sends SDK-invalid null request IDs.
			serverTransport.onmessage!(message as Parameters<NonNullable<SdkTransport["onmessage"]>>[0]);
		},
		close,
		onMessage(listener) {
			events.on("message", listener);
			return () => {
				events.off("message", listener);
			};
		},
		onError(listener) {
			events.on("transport-error", listener);
			return () => {
				events.off("transport-error", listener);
			};
		},
		onClose(listener) {
			events.on("close", listener);
			return () => {
				events.off("close", listener);
			};
		},
	};
	const server = await createConnection(
		{
			browser: { browserName: "firefox", isolated: false },
			capabilities: ["core", "network", "storage", "vision", "devtools"],
			outputDir,
			imageResponses: "allow",
			filePaths: "absolute",
			allowUnrestrictedFileAccess: true,
			timeouts: { action: 30_000, navigation: 60_000, idle: 0 },
		},
		context,
	);
	const client = new McpClient({ name: "pi-browser", version: "1.0.0", requestTimeoutMs: 120_000 });
	try {
		await server.connect(serverTransport);
		await client.connect(transport);
	} catch (error) {
		await Promise.allSettled([client.close(), server.close()]);
		throw error;
	}
	return {
		client,
		async close() {
			await Promise.allSettled([client.close(), server.close()]);
		},
	};
}
