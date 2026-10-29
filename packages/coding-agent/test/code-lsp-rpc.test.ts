import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { LspRpc } from "../src/extensions/code/lsp-rpc.ts";

const fixture = fileURLToPath(new URL("./fixtures/code-lsp-server.mjs", import.meta.url));
const clients: LspRpc[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});
function create() {
	const client = new LspRpc(
		[process.execPath, fixture],
		process.cwd(),
		() => {},
		() => null,
	);
	clients.push(client);
	return client;
}

describe("LSP framed RPC", () => {
	it("reassembles split UTF-8 frames and correlates concurrent responses", async () => {
		const client = create();
		const values: JsonValue[] = [{ text: "привет мир" }, { number: 42 }, [1, "two", null]];
		expect(await Promise.all(values.map((value) => client.request("fixture/echo", value)))).toEqual(values);
	});
	it("reports server-side errors without losing later requests", async () => {
		const client = create();
		await expect(client.request("fixture/unknown", {})).rejects.toThrow("fixture unsupported");
		expect(await client.request("fixture/echo", { ok: true })).toEqual({ ok: true });
	});
	it("cancels pending requests and continues serving", async () => {
		const client = create();
		const controller = new AbortController();
		const pending = client.request("fixture/wait", {}, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("cancelled");
		expect(await client.request("fixture/echo", null)).toBeNull();
	});
	it("times out requests without leaving the connection stuck", async () => {
		const client = create();
		await expect(client.request("fixture/wait", {}, undefined, 30)).rejects.toThrow("timed out");
		expect(await client.request("fixture/echo", true)).toBe(true);
	});
	it("rejects pending work on malformed frames and closes the process", async () => {
		const client = create();
		await expect(client.request("fixture/bad", {})).rejects.toThrow("invalid or oversized");
	});
	it("reports missing executables", async () => {
		const client = new LspRpc(
			["/nonexistent/pi-fixture-language-server"],
			process.cwd(),
			() => {},
			() => null,
		);
		clients.push(client);
		await expect(client.request("initialize", {})).rejects.toThrow("Could not start");
	});
});
