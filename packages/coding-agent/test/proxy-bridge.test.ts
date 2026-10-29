// verifies the owned browser proxy bridge without contacting external services.
import http from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseProxyUrl } from "@earendil-works/pi-ai/utils/proxy-routing";
import { fetch, ProxyAgent } from "undici";
import { describe, expect, it } from "vitest";
import { startSocksProxy } from "../../ai/test/proxy-fixture.ts";
import { createProxyBridge } from "../src/core/proxy-bridge.ts";

describe("browser proxy bridge", () => {
	it("forwards HTTP request bodies and compressed responses without forwarding proxy credentials", async () => {
		const received: string[] = [];
		const auth: (string | undefined)[] = [];
		const origin = http.createServer(async (request, response) => {
			let text = "";
			for await (const chunk of request) text += chunk.toString();
			received.push(text);
			auth.push(request.headers["proxy-authorization"]);
			response.setHeader("content-encoding", "gzip");
			response.end(gzipSync("compressed fixture"));
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const bridge = await createProxyBridge(false);
		try {
			const result = await new Promise<Buffer>((resolve, reject) => {
				const request = http.request(
					{
						host: "127.0.0.1",
						port: parseProxyUrl(bridge.url).port,
						path: `http://127.0.0.1:${address.port}/`,
						method: "POST",
						headers: { "proxy-authorization": "private-local-token" },
					},
					(response) => {
						const chunks: Buffer[] = [];
						response.on("data", (chunk: Buffer) => chunks.push(chunk));
						response.on("end", () => resolve(Buffer.concat(chunks)));
						response.on("error", reject);
					},
				);
				request.on("error", reject);
				request.end("request payload");
			});
			expect(gunzipSync(result).toString()).toBe("compressed fixture");
			expect(received).toEqual(["request payload"]);
			expect(auth).toEqual([undefined]);
		} finally {
			await bridge.close();
			origin.closeAllConnections();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});

	it("bridges CONNECT to authenticated SOCKS without giving its credentials to the browser", async () => {
		let requests = 0;
		const origin = http.createServer((_request, response) => {
			requests++;
			response.end("CONNECT fixture");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const socks = await startSocksProxy(address.port);
		const bridge = await createProxyBridge(socks.url);
		const agent = new ProxyAgent({ uri: bridge.url, proxyTunnel: true });
		try {
			const result = await fetch("http://browser-fixture.invalid:8123/", { dispatcher: agent });
			expect(await result.text()).toBe("CONNECT fixture");
			expect(requests).toBe(1);
			expect(socks.destinations).toEqual(["browser-fixture.invalid:8123"]);
			expect(socks.credentials).toEqual(["fixture-user:fixture-secret"]);
			expect(bridge.url).not.toContain("fixture-secret");
		} finally {
			await agent.destroy();
			await bridge.close();
			await socks.close();
			origin.closeAllConnections();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});

	it("returns a sanitized failure and never attempts a direct origin after proxy failure", async () => {
		let requests = 0;
		const origin = http.createServer((_request, response) => {
			requests++;
			response.end("unexpected direct");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const socks = await startSocksProxy(address.port);
		await socks.close();
		const bridge = await createProxyBridge(socks.url);
		const agent = new ProxyAgent({ uri: bridge.url, proxyTunnel: true });
		try {
			await expect(fetch(`http://127.0.0.1:${address.port}/`, { dispatcher: agent })).rejects.toThrow();
			expect(requests).toBe(0);
		} finally {
			await agent.destroy();
			await bridge.close();
			origin.closeAllConnections();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});
});
