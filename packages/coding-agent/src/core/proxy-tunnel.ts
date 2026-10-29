// opens cancellable TCP tunnels through the configured HTTP, HTTPS or SOCKS proxy.
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import { parseProxyUrl } from "@earendil-works/pi-ai/utils/proxy-routing";
import { SocksClient } from "socks";

/** Connect to a TCP target through one explicit proxy, with no direct fallback. */
export async function connectProxyTunnel(
	proxyValue: string,
	host: string,
	port: number,
	signal?: AbortSignal,
): Promise<Socket> {
	const proxy = parseProxyUrl(proxyValue);
	const timeout = AbortSignal.timeout(15_000);
	const connectSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	connectSignal.throwIfAborted();
	if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:") {
		let socket: Socket | undefined;
		const onAbort = () => socket?.destroy(new Error("Proxy connection aborted"));
		try {
			const destination = proxy.protocol === "socks5:" && !net.isIP(host) ? (await lookup(host)).address : host;
			connectSignal.throwIfAborted();
			socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port) || 1080 });
			connectSignal.addEventListener("abort", onAbort, { once: true });
			if (connectSignal.aborted) onAbort();
			await once(socket, "connect");
			const result = await SocksClient.createConnection({
				proxy: {
					host: proxy.hostname.replace(/^\[|\]$/g, ""),
					port: Number(proxy.port) || 1080,
					type: 5,
					userId: decodeURIComponent(proxy.username),
					password: decodeURIComponent(proxy.password),
				},
				destination: { host: destination, port },
				command: "connect",
				existing_socket: socket,
				timeout: 15_000,
			});
			connectSignal.throwIfAborted();
			socket.setTimeout(0);
			return result.socket;
		} catch {
			socket?.destroy();
			signal?.throwIfAborted();
			throw new Error("SOCKS proxy tunnel failed");
		} finally {
			connectSignal.removeEventListener("abort", onAbort);
		}
	}
	return new Promise<Socket>((resolve, reject) => {
		const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
		const headers: Record<string, string> = { host: authority };
		if (proxy.username || proxy.password) {
			headers["proxy-authorization"] =
				`Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
		}
		const request = (proxy.protocol === "https:" ? https : http).request(proxy, {
			method: "CONNECT",
			path: authority,
			headers,
			agent: false,
		});
		const onAbort = () => request.destroy(new Error("Proxy connection aborted"));
		connectSignal.addEventListener("abort", onAbort, { once: true });
		request.once("connect", (response, socket, head) => {
			connectSignal.removeEventListener("abort", onAbort);
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(new Error(`Proxy CONNECT returned HTTP ${response.statusCode}`));
				return;
			}
			if (head.length) socket.unshift(head);
			resolve(socket);
		});
		request.once("error", () => {
			connectSignal.removeEventListener("abort", onAbort);
			reject(signal?.aborted ? signal.reason : new Error("HTTP proxy tunnel failed"));
		});
		if (connectSignal.aborted) onAbort();
		request.end();
	});
}
