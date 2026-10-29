import { afterEach, describe, expect, it } from "vitest";
import { resolveHttpProxyUrlForTarget, UNSUPPORTED_PROXY_PROTOCOL_MESSAGE } from "../src/utils/node-http-proxy.ts";
import { parseProxyUrl, setProviderProxy } from "../src/utils/proxy-routing.ts";

const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"npm_config_http_proxy",
	"npm_config_https_proxy",
	"npm_config_proxy",
	"npm_config_no_proxy",
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of PROXY_ENV_KEYS) {
	originalEnv.set(key, process.env[key]);
}

function resetProxyEnv(): void {
	for (const key of PROXY_ENV_KEYS) {
		delete process.env[key];
	}
}

afterEach(() => {
	setProviderProxy(undefined);
	resetProxyEnv();
	for (const [key, value] of originalEnv) {
		if (value !== undefined) {
			process.env[key] = value;
		}
	}
});

describe("node HTTP proxy resolution", () => {
	it("respects NO_PROXY exclusions", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "bedrock-runtime.us-east-1.amazonaws.com";

		expect(resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")).toBeUndefined();
	});

	it("resolves HTTP and HTTPS proxy URLs", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";

		expect(resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")?.toString()).toBe(
			"http://proxy.example:8080/",
		);
	});

	it("prefers scoped proxy env aliases before process env aliases", () => {
		resetProxyEnv();
		process.env.https_proxy = "http://process-proxy.example:8080";

		expect(
			resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com", {
				HTTPS_PROXY: "http://scoped-proxy.example:8080",
			})?.toString(),
		).toBe("http://scoped-proxy.example:8080/");
	});

	it("rejects PAC proxy URLs explicitly", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "pac+https://proxy.example/proxy.pac";

		expect(() => resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")).toThrow(
			UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
		);
	});

	it("supports HTTP, HTTPS, SOCKS5 and SOCKS5h without exporting proxy settings", () => {
		resetProxyEnv();
		process.env.NO_PROXY = "*";
		for (const protocol of ["http", "https", "socks5", "socks5h"]) {
			setProviderProxy(`${protocol}://fixture-user:fixture-secret@proxy.example:1080`);
			expect(resolveHttpProxyUrlForTarget("https://example.org")?.protocol).toBe(`${protocol}:`);
			expect(process.env.HTTPS_PROXY).toBeUndefined();
			expect(process.env.HTTP_PROXY).toBeUndefined();
		}
	});

	it("explicit direct routing overrides ambient proxies", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://ambient.example:8080";
		setProviderProxy(false);
		expect(resolveHttpProxyUrlForTarget("https://example.org")).toBeUndefined();
	});

	it("rejects malformed settings before changing the active route", () => {
		setProviderProxy("http://proxy.example:8080");
		for (const invalid of [
			"http://user:%zz@proxy.example",
			"http://proxy.example/path",
			"http://proxy.example?secret",
			"http://proxy.example#secret",
		]) {
			expect(() => setProviderProxy(invalid)).toThrow();
			expect(resolveHttpProxyUrlForTarget("https://example.org")?.hostname).toBe("proxy.example");
		}
		expect(parseProxyUrl("socks5h://proxy.example").protocol).toBe("socks5h:");
	});

	it("never includes credentials in invalid proxy errors", () => {
		resetProxyEnv();
		for (const proxy of [
			"http://fixture-user:fixture-secret@[invalid",
			"private-secret://fixture-user:fixture-secret@proxy.example",
		]) {
			process.env.HTTPS_PROXY = proxy;
			let message = "";
			try {
				resolveHttpProxyUrlForTarget("https://example.org");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).not.toBe("");
			expect(message).not.toContain("fixture-user");
			expect(message).not.toContain("fixture-secret");
			expect(message).not.toContain("private-secret");
		}
	});

	it("handles subdomain wildcards, IPv6, and ports in NO_PROXY", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "example.com, .wildcard.org, *.star.net, ::1, [2001:db8::1], 127.0.0.1:8080";

		expect(resolveHttpProxyUrlForTarget("https://example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://notexample.com")?.toString()).toBe("http://proxy.example:8080/");

		expect(resolveHttpProxyUrlForTarget("https://[::1]:80")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://[2001:db8::1]")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:8080")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:3000")?.toString()).toBe("http://proxy.example:8080/");
	});
});
