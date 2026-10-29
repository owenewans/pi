// tests cancellable proxy tunnels against disposable local servers.
import http from "node:http";
import net, { type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { startSocksProxy } from "../../ai/test/proxy-fixture.ts";
import { connectProxyTunnel } from "../src/core/proxy-tunnel.ts";

async function readSocket(socket: Socket): Promise<string> {
	let text = "";
	for await (const chunk of socket) text += chunk.toString();
	return text;
}

describe("proxy tunnels", () => {
	it("authenticates SOCKS5h and leaves DNS resolution to the proxy", async () => {
		const origin = http.createServer((_request, response) => response.end("tunneled"));
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		try {
			const socket = await connectProxyTunnel(proxy.url, "remote.invalid", 8123);
			socket.write("GET / HTTP/1.1\r\nHost: remote.invalid\r\nConnection: close\r\n\r\n");
			expect(await readSocket(socket)).toContain("tunneled");
			expect(proxy.destinations).toEqual(["remote.invalid:8123"]);
			expect(proxy.credentials).toEqual(["fixture-user:fixture-secret"]);
		} finally {
			await proxy.close();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});

	it("opens HTTP CONNECT with authentication and preserves buffered tunnel bytes", async () => {
		const requests: string[] = [];
		const auth: (string | undefined)[] = [];
		const proxy = http.createServer();
		proxy.on("connect", (request, socket) => {
			requests.push(request.url ?? "");
			auth.push(request.headers["proxy-authorization"]);
			socket.end("HTTP/1.1 200 Connection Established\r\n\r\npreface");
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");
		try {
			const socket = await connectProxyTunnel(
				`http://fixture:private@127.0.0.1:${address.port}`,
				"2001:db8::1",
				443,
			);
			expect(await readSocket(socket)).toBe("preface");
			expect(requests).toEqual(["[2001:db8::1]:443"]);
			expect(auth).toEqual([`Basic ${Buffer.from("fixture:private").toString("base64")}`]);
		} finally {
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it("reports proxy rejection without credentials or a direct fallback", async () => {
		const proxy = http.createServer();
		proxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");
		try {
			await expect(
				connectProxyTunnel(`http://fixture:private@127.0.0.1:${address.port}`, "remote.invalid", 443),
			).rejects.toThrow("Proxy CONNECT returned HTTP 407");
		} finally {
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});

	it.each(["socks5h", "http"])("cancels a stalled %s handshake", async (protocol) => {
		const sockets = new Set<Socket>();
		const proxy = net.createServer((socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("proxy did not bind");
		try {
			await expect(
				connectProxyTunnel(
					`${protocol}://127.0.0.1:${address.port}`,
					"remote.invalid",
					443,
					AbortSignal.timeout(30),
				),
			).rejects.toThrow();
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		}
	});
});
