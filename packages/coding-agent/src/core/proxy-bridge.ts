// keeps upstream proxy credentials out of browser processes through an owned loopback proxy.
import http from "node:http";
import net, { type Socket } from "node:net";
import { resolveAmbientHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import type { Dispatcher } from "undici";
import { createHttpDispatcher } from "./http-dispatcher.ts";
import { connectProxyTunnel } from "./proxy-tunnel.ts";

export type ProxyBridge = { url: string; close(): Promise<void> };

/** Start a loopback HTTP/CONNECT bridge that never retries through a different route. */
export async function createProxyBridge(route: string | false | undefined): Promise<ProxyBridge> {
	const sockets = new Set<Socket>();
	const controller = new AbortController();
	const dispatcher = createHttpDispatcher(60_000, route);
	const server = http.createServer(async (request, response) => {
		try {
			const target = new URL(request.url ?? "");
			if (target.protocol !== "http:" && target.protocol !== "https:")
				throw new Error("Unsupported origin protocol");
			const headers = { ...request.headers };
			for (const name of ["proxy-authorization", "proxy-connection", "connection", "transfer-encoding"])
				delete headers[name];
			// the HTTP parser validates request methods before this wire-input boundary.
			const method = (request.method ?? "GET") as Dispatcher.HttpMethod;
			const upstream = await dispatcher.request({
				origin: target.origin,
				path: `${target.pathname}${target.search}`,
				method,
				headers,
				body: method === "GET" || method === "HEAD" ? undefined : request,
				signal: controller.signal,
			});
			response.on("close", () => upstream.body.destroy());
			upstream.body.on("error", () => response.destroy());
			response.writeHead(upstream.statusCode, upstream.headers);
			upstream.body.pipe(response);
		} catch {
			if (response.headersSent) response.destroy();
			else {
				response.writeHead(502);
				response.end("Proxy request failed");
			}
		}
	});
	server.on("connection", (socket) => track(socket));
	server.on("connect", async (request, client, head) => {
		try {
			// CONNECT authorities arrive from the browser as untrusted wire input.
			const target = new URL(`https://${request.url}`);
			if (
				!target.hostname ||
				target.username ||
				target.password ||
				target.pathname !== "/" ||
				target.search ||
				target.hash
			)
				throw new Error("Invalid CONNECT target");
			const host = target.hostname.replace(/^\[|\]$/g, "");
			const port = Number(target.port) || 443;
			const proxy =
				route === undefined ? resolveAmbientHttpProxyUrlForTarget(`https://${target.host}`)?.href : route;
			const upstream = proxy
				? await connectProxyTunnel(proxy, host, port, controller.signal)
				: await connectDirect(host, port, controller.signal);
			track(upstream);
			if (client.destroyed) {
				upstream.destroy();
				return;
			}
			client.on("error", () => upstream.destroy());
			upstream.on("error", () => client.destroy());
			client.on("close", () => upstream.destroy());
			upstream.on("close", () => client.destroy());
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream).pipe(client);
		} catch {
			client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
		}
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
	} catch {
		await dispatcher.destroy();
		throw new Error("Could not start browser proxy bridge");
	}
	server.unref();
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Proxy bridge did not bind");
	let closed = false;
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			if (closed) return;
			closed = true;
			controller.abort();
			for (const socket of sockets) socket.destroy();
			await dispatcher.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};

	function track(socket: Socket): void {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => sockets.delete(socket));
	}
}

function connectDirect(host: string, port: number, signal: AbortSignal): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port, signal });
		socket.setTimeout(15_000, () => socket.destroy(new Error("Connection timed out")));
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.setTimeout(0);
			resolve(socket);
		});
	});
}
