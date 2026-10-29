// tests ACP session translation with an isolated fake RPC child.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { AcpAgent } from "../src/modes/acp/agent.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const agents: AcpAgent[] = [];
afterEach(async () => {
	await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

async function setup() {
	const updates: SessionNotification[] = [];
	// The adapter calls only sessionUpdate on this test connection.
	const connection = {
		sessionUpdate: async (event: SessionNotification) => {
			updates.push(event);
		},
	} as AgentSideConnection;
	const fixture = fileURLToPath(new URL("./fixtures/acp-rpc.mjs", import.meta.url));
	const agent = new AcpAgent(connection, (cwd) => new RpcClient({ cwd, cliPath: fixture }));
	agents.push(agent);
	const { sessionId, configOptions } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
	return { agent, sessionId, updates, configOptions };
}

it("translates streamed text, tool calls and file locations", async () => {
	const { agent, sessionId, updates } = await setup();
	const result = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] });
	expect(result.stopReason).toBe("end_turn");
	expect(updates.map((item) => item.update.sessionUpdate)).toEqual([
		"agent_message_chunk",
		"tool_call",
		"tool_call_update",
	]);
	expect(updates[1].update).toMatchObject({ locations: [{ path: `${process.cwd()}/file.txt` }] });
});

it("advertises terminal login and rejects unknown auth methods", async () => {
	const { agent } = await setup();
	expect((await agent.initialize()).authMethods).toMatchObject([{ id: "terminal", type: "terminal" }]);
	await expect(agent.authenticate({ methodId: "terminal" })).resolves.toBeUndefined();
	await expect(agent.authenticate({ methodId: "invalid" })).rejects.toThrow();
});

it("advertises available models and applies a selected model", async () => {
	const { agent, sessionId, configOptions } = await setup();
	expect(configOptions[0]).toMatchObject({ id: "model", currentValue: JSON.stringify(["fixture", "one"]) });
	const result = await agent.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: JSON.stringify(["fixture", "two"]),
	});
	expect(result.configOptions[0]).toMatchObject({ currentValue: JSON.stringify(["fixture", "two"]) });
	await expect(agent.setSessionConfigOption({ sessionId, configId: "model", value: "missing" })).rejects.toThrow();
});

it("requests authentication when the selected model has no credentials", async () => {
	const { agent, sessionId } = await setup();
	await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "noauth" }] })).rejects.toMatchObject({
		code: -32000,
	});
});

it("propagates cancellation and child exit without hanging", async () => {
	const { agent, sessionId } = await setup();
	const pending = agent.prompt({ sessionId, prompt: [{ type: "text", text: "hold" }] });
	await new Promise((resolve) => setTimeout(resolve, 50));
	await agent.cancel({ sessionId });
	expect((await pending).stopReason).toBe("cancelled");
	await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "crash" }] })).rejects.toThrow();
});

it("reloads an open session before its first message is saved", async () => {
	const { agent, sessionId } = await setup();
	const result = await agent.loadSession({ cwd: process.cwd(), sessionId, mcpServers: [] });
	expect(result.configOptions[0]).toMatchObject({ id: "model" });
});

it("lists and reloads a saved session with replayed messages", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-acp-history-"));
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
	try {
		const manager = SessionManager.create(directory);
		manager.appendMessage({ role: "user", content: "previous request", timestamp: Date.now() });
		const id = manager.getSessionId();
		const updates: SessionNotification[] = [];
		const connection = {
			sessionUpdate: async (event: SessionNotification) => {
				updates.push(event);
			},
		} as AgentSideConnection;
		const fixture = fileURLToPath(new URL("./fixtures/acp-rpc.mjs", import.meta.url));
		const agent = new AcpAgent(
			connection,
			(cwd, sessionId) => new RpcClient({ cwd, cliPath: fixture, env: { FIXTURE_SESSION: sessionId ?? id } }),
		);
		agents.push(agent);
		expect((await agent.listSessions({ cwd: directory })).sessions.map((session) => session.sessionId)).toContain(id);
		await agent.loadSession({ cwd: directory, sessionId: id, mcpServers: [] });
		expect(updates.map((event) => event.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
		await agent.close();
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
		rmSync(directory, { recursive: true, force: true });
	}
});

it("refuses ACP-provided MCP servers instead of ignoring them", async () => {
	const { agent } = await setup();
	await expect(
		agent.newSession({
			cwd: process.cwd(),
			mcpServers: [{ name: "fixture", command: "fixture", args: [], env: [] }],
		}),
	).rejects.toThrow();
});
