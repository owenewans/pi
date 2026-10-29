import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { resolveHttpProxyUrlForTarget } from "@earendil-works/pi-ai/utils/node-http-proxy";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSocksProxy } from "../../ai/test/proxy-fixture.ts";
import {
	applyHttpProxySettings,
	configureHttpDispatcher,
	createHttpDispatcher,
	fetchService,
	getServiceProxy,
} from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;
const DISPATCHER_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		applyHttpProxySettings(undefined);
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("routes providers without exporting credentials to child processes", () => {
		applyHttpProxySettings("http://fixture:private@127.0.0.1:7890");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://example.org")?.port).toBe("7890");
	});

	it("preserves ambient proxy variables while preferring explicit settings", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890");

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
		expect(resolveHttpProxyUrlForTarget("https://example.org")?.hostname).toBe("settings");
	});

	it("inherits shared routes and preserves explicit service overrides", () => {
		applyHttpProxySettings("socks5h://shared.example:1080", {
			providers: "http://provider.example:8080",
			web: false,
		});
		expect(getServiceProxy("browser")).toBe("socks5h://shared.example:1080");
		expect(getServiceProxy("web")).toBe(false);
		expect(resolveHttpProxyUrlForTarget("https://example.org")?.hostname).toBe("provider.example");
		expect(() => applyHttpProxySettings("http://next.example", { web: "invalid" })).toThrow();
		expect(getServiceProxy("browser")).toBe("socks5h://shared.example:1080");
		expect(getServiceProxy("web")).toBe(false);
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});
});

describe("http dispatcher", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedProxyEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedProxyEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof DISPATCHER_PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(async () => {
		applyHttpProxySettings(undefined);
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedProxyEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("tunnels proxied HTTP origins", async () => {
		const origin = http.createServer((_request, response) => {
			response.end("origin");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const originAddress = origin.address();
		if (!originAddress || typeof originAddress === "string") {
			throw new Error("Origin did not bind to a TCP port");
		}

		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.once("data", (data) => {
				const [requestLine = ""] = data.toString().split("\r\n");
				proxyRequestLines.push(requestLine);
				if (!requestLine.startsWith("CONNECT ")) {
					client.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
					return;
				}

				const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") {
			throw new Error("Proxy did not bind to a TCP port");
		}

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		try {
			const originUrl = `http://127.0.0.1:${originAddress.port}/v1/chat/completions`;
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			expect(proxyRequestLines).not.toHaveLength(0);
			expect(proxyRequestLines).toEqual(
				expect.arrayContaining([
					expect.stringMatching(`^CONNECT 127\\.0\\.0\\.1:${originAddress.port} HTTP/1\\.1$`),
				]),
			);
		} finally {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
		}
	});

	it.each(["socks5", "socks5h"])(
		"routes authenticated %s traffic without leaking proxy credentials to origins",
		async (protocol) => {
			const originHeaders: http.IncomingHttpHeaders[] = [];
			const origin = http.createServer((request, response) => {
				originHeaders.push(request.headers);
				response.end("socks origin");
			});
			await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
			const address = origin.address();
			if (!address || typeof address === "string") throw new Error("origin did not bind");
			const proxy = await startSocksProxy(address.port);
			applyHttpProxySettings(proxy.url.replace("socks5h:", `${protocol}:`));
			const dispatcher = createHttpDispatcher(1000, getServiceProxy("providers"));
			try {
				const host = protocol === "socks5" ? "localhost" : "remote.invalid";
				expect(await (await undici.fetch(`http://${host}:8123/`, { dispatcher })).text()).toBe("socks origin");
				if (protocol === "socks5") expect(proxy.destinations[0]).toMatch(/^(127\.0\.0\.1|(?:0\.){15}1):8123$/);
				else expect(proxy.destinations).toEqual(["remote.invalid:8123"]);
				expect(proxy.credentials).toEqual(["fixture-user:fixture-secret"]);
				expect(originHeaders[0]["proxy-authorization"]).toBeUndefined();
				expect(originHeaders[0].authorization).toBeUndefined();
			} finally {
				await dispatcher.destroy();
				await proxy.close();
				await new Promise<void>((resolve) => origin.close(() => resolve()));
			}
		},
	);

	it("fails local DNS without contacting a SOCKS proxy", async () => {
		const proxy = await startSocksProxy(1);
		const dispatcher = createHttpDispatcher(1000, proxy.url.replace("socks5h:", "socks5:"));
		try {
			await expect(undici.fetch("http://nonexistent.invalid/", { dispatcher })).rejects.toThrow();
			expect(proxy.destinations).toEqual([]);
		} finally {
			await dispatcher.destroy();
			await proxy.close();
		}
	});

	it("enforces body idle timeouts through SOCKS", async () => {
		const origin = http.createServer((_request, response) => {
			response.writeHead(200);
			response.write("partial");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		const dispatcher = createHttpDispatcher(30, proxy.url);
		try {
			const response = await undici.fetch("http://remote.invalid/", { dispatcher });
			await expect(response.text()).rejects.toThrow();
		} finally {
			await dispatcher.destroy();
			await proxy.close();
			origin.closeAllConnections();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});

	it("uses a service override and never retries directly after proxy failure", async () => {
		let directRequests = 0;
		const origin = http.createServer((_request, response) => {
			directRequests++;
			response.end("routed");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		const target = `http://127.0.0.1:${address.port}/`;
		try {
			applyHttpProxySettings("http://127.0.0.1:1", { web: proxy.url });
			expect(await (await fetchService("web", target)).text()).toBe("routed");
			expect(proxy.destinations).toHaveLength(1);
			applyHttpProxySettings(undefined);
			await proxy.close();
			directRequests = 0;
			applyHttpProxySettings(proxy.url);
			await expect(fetchService("web", target)).rejects.toThrow();
			expect(directRequests).toBe(0);
		} finally {
			applyHttpProxySettings(undefined);
			await proxy.close();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});

	it("allows two seconds for HTTPS connection attempts without changing the Node default", async () => {
		// Preserve a deliberate host fetch override while testing the dispatcher itself.
		globalThis.fetch = async () => {
			throw new Error("Unexpected global fetch");
		};
		const originalAttemptTimeoutMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
		const connectSpy = vi.spyOn(tls, "connect").mockImplementation(() => {
			throw new Error("Connection captured");
		});

		configureHttpDispatcher();
		await expect(undici.fetch("https://example.invalid")).rejects.toThrow();

		expect(connectSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				autoSelectFamilyAttemptTimeout: 2_000,
			}),
		);
		expect(connectSpy.mock.calls[0]?.[0]).not.toHaveProperty("autoSelectFamily");
		expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(originalAttemptTimeoutMs);
	});
});
