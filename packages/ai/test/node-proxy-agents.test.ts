// checks SDK proxy routing against disposable local servers without account credentials.

import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAuth } from "google-auth-library";
import { afterEach, describe, expect, it } from "vitest";
import { createProviderProxyAgents } from "../src/internal/node-proxy-agents.ts";
import { vertexProxyAuthOptions } from "../src/internal/vertex-proxy-auth.ts";
import { setProviderProxy } from "../src/utils/proxy-routing.ts";
import { startSocksProxy } from "./proxy-fixture.ts";

afterEach(() => setProviderProxy(undefined));

describe("Node SDK proxy agents", () => {
	it("sends authenticated SOCKS5h requests with remote DNS", async () => {
		const origin = http.createServer((_request, response) => response.end("through proxy"));
		origin.listen(0, "127.0.0.1");
		await once(origin, "listening");
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		setProviderProxy(proxy.url);
		const target = "http://unresolvable.invalid:8123/";
		const agents = createProviderProxyAgents(target)!;
		try {
			const body = await new Promise<string>((resolve, reject) => {
				const request = http.get(target, { agent: agents.httpAgent }, (response) => {
					let content = "";
					response.setEncoding("utf8");
					response.on("data", (chunk: string) => {
						content += chunk;
					});
					response.on("end", () => resolve(content));
					response.on("error", reject);
				});
				request.on("error", reject);
			});
			expect(body).toBe("through proxy");
			expect(proxy.destinations).toEqual(["unresolvable.invalid:8123"]);
			expect(proxy.credentials).toEqual(["fixture-user:fixture-secret"]);
		} finally {
			agents.httpAgent.destroy();
			await proxy.close();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});

	it("fails without a direct attempt when the SOCKS proxy is unavailable", async () => {
		let directRequests = 0;
		const origin = http.createServer((_request, response) => {
			directRequests++;
			response.end("direct");
		});
		origin.listen(0, "127.0.0.1");
		await once(origin, "listening");
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		setProviderProxy(proxy.url);
		await proxy.close();
		const target = `http://127.0.0.1:${address.port}/`;
		const agents = createProviderProxyAgents(target)!;
		try {
			await expect(
				new Promise((resolve, reject) => {
					const request = http.get(target, { agent: agents.httpAgent }, resolve);
					request.on("error", reject);
				}),
			).rejects.toThrow("SOCKS proxy connection failed");
			expect(directRequests).toBe(0);
		} finally {
			agents.httpAgent.destroy();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	});

	it("routes Google ADC token refresh through SOCKS without direct fallback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vertex-proxy-"));
		const origin = http.createServer((_request, response) => response.end());
		origin.listen(0, "127.0.0.1");
		await once(origin, "listening");
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		try {
			const file = join(dir, "credentials.json");
			writeFileSync(
				file,
				JSON.stringify({
					type: "authorized_user",
					client_id: "fixture",
					client_secret: "fixture",
					refresh_token: "fixture",
				}),
			);
			setProviderProxy(proxy.url);
			const options = vertexProxyAuthOptions("fixture", { GOOGLE_APPLICATION_CREDENTIALS: file });
			const auth = new GoogleAuth({ ...options, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
			await expect(auth.getRequestHeaders("https://example.invalid")).rejects.toThrow();
			expect(proxy.destinations).toContain("oauth2.googleapis.com:443");
		} finally {
			await proxy.close();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes service-account token exchange through SOCKS", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vertex-service-"));
		const origin = http.createServer((_request, response) => response.end());
		origin.listen(0, "127.0.0.1");
		await once(origin, "listening");
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		try {
			const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
			const file = join(dir, "credentials.json");
			writeFileSync(
				file,
				JSON.stringify({
					type: "service_account",
					client_email: "fixture@example.invalid",
					private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
					token_uri: "https://oauth2.googleapis.com/token",
				}),
			);
			setProviderProxy(proxy.url);
			const options = vertexProxyAuthOptions("fixture", { GOOGLE_APPLICATION_CREDENTIALS: file });
			const auth = new GoogleAuth({ ...options, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
			await expect(auth.getRequestHeaders("https://example.invalid")).rejects.toThrow();
			expect(proxy.destinations).toContain("oauth2.googleapis.com:443");
		} finally {
			await proxy.close();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns no agent for an explicitly direct route", () => {
		setProviderProxy(false);
		expect(createProviderProxyAgents("https://example.org")).toBeUndefined();
	});
});
