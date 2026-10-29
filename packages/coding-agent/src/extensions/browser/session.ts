// owns a lazy persistent Camoufox context, its private profile and optional Xvfb display.
import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, firefox } from "playwright-core";
import { expandTildePath, getAgentDir } from "../../config.ts";
import { type BrowserMode, readBrowserMode, writeBrowserMode } from "../../core/browser-settings.ts";
import { getServiceProxy } from "../../core/http-dispatcher.ts";
import { createProxyBridge, type ProxyBridge } from "../../core/proxy-bridge.ts";

export type BrowserSession = {
	context(): Promise<BrowserContext>;
	setMode(mode: BrowserMode): Promise<void>;
	close(): Promise<void>;
	outputDir: string;
};

type Display = { value: string; close(): void };
type Running = {
	context: BrowserContext;
	bridge: ProxyBridge;
	display?: Display;
	route: string | false | undefined;
	mode: BrowserMode;
};

/** Create a lazy Camoufox owner; no browser or display starts until context() runs. */
export function createBrowserSession(): BrowserSession {
	const root = join(getAgentDir(), "browser");
	const outputDir = join(root, "artifacts");
	let current: Running | undefined;
	let pending: Promise<BrowserContext> | undefined;
	let closed = false;
	let restoreURLs: string[] = [];
	const stop = async () => {
		const running = current;
		current = undefined;
		if (!running) return;
		restoreURLs = running.context
			.pages()
			.map((page) => page.url())
			.filter((url) => url !== "about:blank");
		try {
			await running.context.close();
		} finally {
			await running.bridge.close();
			running.display?.close();
		}
	};
	return {
		outputDir,
		async context() {
			if (closed) throw new Error("Browser session is closed");
			const mode = readBrowserMode() ?? "headless";
			const route = getServiceProxy("browser");
			if (current && (current.mode !== mode || current.route !== route)) await stop();
			if (current) return current.context;
			if (pending) return pending;
			pending = (async () => {
				const executable = expandTildePath(
					process.env.CAMOUFOX_EXECUTABLE ??
						join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "camoufox", "camoufox-bin"),
				);
				try {
					await access(executable, constants.X_OK);
				} catch {
					throw new Error("Camoufox is not installed; install it or set CAMOUFOX_EXECUTABLE");
				}
				const profile = join(root, "profile");
				for (const directory of [root, profile, outputDir]) {
					await mkdir(directory, { recursive: true, mode: 0o700 });
					await chmod(directory, 0o700);
				}
				let display: Display | undefined;
				let bridge: ProxyBridge | undefined;
				let context: BrowserContext | undefined;
				try {
					if (mode === "xvfb") display = await startDisplay();
					bridge = await createProxyBridge(route);
					context = await firefox.launchPersistentContext(profile, {
						executablePath: executable,
						headless: mode === "headless",
						viewport: mode === "headless" ? { width: 1280, height: 720 } : null,
						proxy: { server: bridge.url },
						firefoxUserPrefs: {
							"network.proxy.no_proxies_on": "",
							"network.proxy.allow_hijacking_localhost": true,
						},
						env: browserEnvironment(display?.value),
						timeout: 30_000,
					});
					if (closed) throw new Error("Browser session is closed");
					context.setDefaultTimeout(30_000);
					const running: Running = { context, bridge, display, mode, route };
					current = running;
					context.once("close", () => {
						if (current !== running) return;
						current = undefined;
						void running.bridge.close();
						running.display?.close();
					});
					const urls = restoreURLs;
					restoreURLs = [];
					for (const url of urls) {
						const page = await context.newPage();
						await page.goto(url).catch(() => {});
					}
					return context;
				} catch {
					await context?.close().catch(() => {});
					await bridge?.close();
					display?.close();
					throw new Error("Camoufox could not start; check its installation, display and profile lock");
				}
			})().finally(() => {
				pending = undefined;
			});
			return pending;
		},
		async setMode(mode) {
			if (closed) throw new Error("Browser session is closed");
			await pending?.catch(() => {});
			await stop();
			writeBrowserMode(mode);
		},
		async close() {
			if (closed) return;
			closed = true;
			await pending?.catch(() => {});
			await stop();
		},
	};
}

function browserEnvironment(display?: string): Record<string, string> {
	const env: Record<string, string> = { CAMOU_CONFIG_1: "{}" };
	for (const key of [
		"PATH",
		"HOME",
		"LANG",
		"LC_ALL",
		"XDG_RUNTIME_DIR",
		"XDG_CACHE_HOME",
		"FONTCONFIG_PATH",
		"FONTCONFIG_FILE",
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"XAUTHORITY",
		"DBUS_SESSION_BUS_ADDRESS",
	]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (display) {
		delete env.WAYLAND_DISPLAY;
		env.DISPLAY = display;
		env.MOZ_ENABLE_WAYLAND = "0";
		env.GDK_BACKEND = "x11";
	}
	return env;
}

function startDisplay(): Promise<Display> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(
			"Xvfb",
			["-displayfd", "1", "-screen", "0", "1280x720x24", "-nolisten", "tcp"],
			{ stdio: ["ignore", "pipe", "ignore"], env: browserEnvironment() },
		);
		let output = "";
		let ready = false;
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Xvfb startup timed out"));
		}, 15_000);
		child.once("error", () => {
			clearTimeout(timer);
			reject(new Error("Could not start Xvfb"));
		});
		child.once("exit", () => {
			clearTimeout(timer);
			if (!ready) reject(new Error("Xvfb exited before startup"));
		});
		child.stdout!.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (!output.includes("\n") || ready) return;
			if (!/^\d+\n$/.test(output)) {
				child.kill();
				clearTimeout(timer);
				reject(new Error("Invalid Xvfb display"));
				return;
			}
			ready = true;
			clearTimeout(timer);
			resolve({
				value: `:${output.trim()}`,
				close: () => {
					child.kill();
				},
			});
		});
	});
}
