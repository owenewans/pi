// runs Camoufox against a local fixture when its external binary is installed.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { firefox } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSocksProxy } from "../../ai/test/proxy-fixture.ts";
import { readBrowserMode, writeBrowserMode } from "../src/core/browser-settings.ts";
import { applyHttpProxySettings } from "../src/core/http-dispatcher.ts";
import { connectPlaywright } from "../src/extensions/browser/connection.ts";
import { createBrowserSession } from "../src/extensions/browser/session.ts";

const executable =
	process.env.CAMOUFOX_EXECUTABLE ??
	join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "camoufox/camoufox-bin");
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-browser-test-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	vi.stubEnv("CAMOUFOX_EXECUTABLE", executable);
	vi.stubEnv("ANTHROPIC_API_KEY", "fixture-provider-secret");
	writeBrowserMode("headless");
});
afterEach(() => {
	applyHttpProxySettings(undefined);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!existsSync(executable))("external Camoufox", () => {
	it("lazily lists Playwright tools and navigates through an authenticated proxy without exposing secrets to the browser", async () => {
		const origin = http.createServer((_request, response) => {
			response.setHeader("content-type", "text/html");
			response.end("<title>browser fixture</title><button>fixture action</button>");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		const proxy = await startSocksProxy(address.port);
		applyHttpProxySettings(undefined, { browser: proxy.url });
		const launch = vi.spyOn(firefox, "launchPersistentContext");
		const session = createBrowserSession();
		const connection = await connectPlaywright(() => session.context(), session.outputDir);
		try {
			const tools = await connection.client.listTools();
			expect(tools.some((tool) => tool.name === "browser_navigate")).toBe(true);
			expect(tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);
			expect(launch).not.toHaveBeenCalled();
			const result = await connection.client.callTool(
				"browser_navigate",
				{ url: "http://browser-fixture.invalid:8123/" },
				{ timeoutMs: 60_000 },
			);
			expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
			const snapshot = await connection.client.callTool("browser_snapshot", {});
			expect(JSON.stringify(snapshot.content)).toContain("fixture action");
			expect(launch).toHaveBeenCalledTimes(1);
			const options = launch.mock.calls[0][1];
			expect(JSON.stringify(options)).not.toContain("fixture-provider-secret");
			expect(JSON.stringify(options)).not.toContain("fixture-secret");
			expect(options?.env?.HTTP_PROXY).toBeUndefined();
			expect(options?.env?.HTTPS_PROXY).toBeUndefined();
			expect(proxy.credentials).toContain("fixture-user:fixture-secret");
			expect(proxy.destinations).toContain("browser-fixture.invalid:8123");
		} finally {
			await connection.close();
			await session.close();
			await proxy.close();
			origin.closeAllConnections();
			await new Promise<void>((resolve) => origin.close(() => resolve()));
		}
	}, 90_000);

	it("switches to Xvfb, reopens tab URLs and preserves profile cookies", async () => {
		applyHttpProxySettings(undefined, { browser: false });
		const session = createBrowserSession();
		try {
			const first = await session.context();
			const page = await first.newPage();
			await page.goto("data:text/html,<title>saved tab</title>");
			await first.addCookies([
				{
					name: "fixture",
					value: "saved",
					domain: "example.invalid",
					path: "/",
					expires: Math.floor(Date.now() / 1000) + 3600,
				},
			]);
			await session.setMode("xvfb");
			expect(readBrowserMode()).toBe("xvfb");
			const second = await session.context();
			expect(second).not.toBe(first);
			expect(await second.cookies()).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "fixture", value: "saved" })]),
			);
			expect(await Promise.all(second.pages().map((item) => item.title()))).toContain("saved tab");
		} finally {
			await session.close();
		}
	}, 90_000);
});
