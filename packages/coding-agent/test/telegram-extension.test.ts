// exercises the Telegram bridge against an in-memory account-free HTTP fixture.
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import telegramExtension from "../src/extensions/telegram/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let directory: string;
let server: http.Server;
let runner: ExtensionRunner | undefined;
let requests: string[];
let calls: { name: string; arguments: Record<string, unknown> }[];
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "pi-telegram-extension-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("HOME", directory);
	requests = [];
	calls = [];
	server = http.createServer(async (request, response) => {
		if (request.method === "DELETE") {
			response.writeHead(202);
			response.end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		// the fixture receives only our native MCP client's controlled JSON-RPC requests.
		const message = JSON.parse(body) as {
			id?: number;
			method: string;
			params: { name: string; arguments: Record<string, unknown> };
		};
		requests.push(message.method);
		if (message.id === undefined) {
			response.writeHead(202);
			response.end();
			return;
		}
		let result: unknown;
		if (message.method === "initialize")
			result = {
				protocolVersion: LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "telegram-fixture", version: "1" },
			};
		else if (message.method === "tools/list")
			result = {
				tools: ["get_messages", "download_media", "send_message", "export_chat_invite"].map((name) => ({
					name,
					inputSchema: { type: "object" },
					annotations: { readOnlyHint: true },
				})),
			};
		else {
			calls.push(message.params);
			result = { content: [{ type: "text", text: "fixture messages" }] };
		}
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture did not bind");
	vi.stubEnv("TELEGRAM_MCP_URL", `http://127.0.0.1:${address.port}/mcp`);
});
afterEach(async () => {
	await runner?.emit({ type: "session_shutdown", reason: "quit" });
	runner = undefined;
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		telegramExtension,
		directory,
		createEventBus(),
		runtime,
		"builtin:telegram",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const current = new ExtensionRunner([extension], runtime, directory, SessionManager.inMemory(directory), registry);
	runner = current;
	const tool = extension.tools.get("telegram")!.definition;
	return (params: { action: "list" | "call"; tool?: string; args?: Record<string, unknown> }, signal?: AbortSignal) =>
		tool.execute("fixture", params, signal, undefined, current.createToolContext("fixture", undefined));
}

describe("Telegram bridge", () => {
	it("filters mutation tools even when the server claims they are read-only", async () => {
		const call = await setup();
		const result = await call({ action: "list" });
		const text = result.content[0];
		if (text.type !== "text") throw new Error("expected text");
		expect(text.text).toContain("get_messages");
		expect(text.text).toContain("download_media");
		expect(text.text).not.toContain("send_message");
		expect(text.text).not.toContain("export_chat_invite");
	});
	it("blocks mutations before contacting the service", async () => {
		const call = await setup();
		await expect(call({ action: "call", tool: "send_message", args: { text: "forbidden" } })).rejects.toThrow(
			"not permitted",
		);
		expect(requests).toEqual([]);
	});
	it("shares one connection for message reads and constrains download paths", async () => {
		const call = await setup();
		await call({ action: "call", tool: "get_messages", args: { chat_id: "fixture" } });
		await call({
			action: "call",
			tool: "download_media",
			args: { chat_id: "fixture", message_id: 1, file_path: "fixture.bin" },
		});
		expect(requests.filter((method) => method === "initialize")).toHaveLength(1);
		expect(calls[1].arguments.file_path).toBe(join(directory, "Downloads/telegram/fixture.bin"));
		await expect(
			call({ action: "call", tool: "download_media", args: { file_path: "../escape" } }),
		).rejects.toThrow();
		expect(calls).toHaveLength(2);
	});
	it("does not connect after cancellation and does not stop the shared service at shutdown", async () => {
		const call = await setup();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(call({ action: "list" }, controller.signal)).rejects.toThrow("cancelled");
		expect(requests).toEqual([]);
		await call({ action: "list" });
		await runner!.emit({ type: "session_shutdown", reason: "quit" });
		expect(server.listening).toBe(true);
	});
});
