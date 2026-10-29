// runs the shared Telegram MCP service through pi's private proxy bridge.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTelegramServiceScriptPath } from "../../config.ts";
import { getServiceProxy } from "../../core/http-dispatcher.ts";
import { createProxyBridge } from "../../core/proxy-bridge.ts";

/** Own a local read-only Telegram service until it exits or receives a termination signal. */
export async function runTelegramService(): Promise<number> {
	const root = join(homedir(), "Downloads", "telegram");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const bridge = await createProxyBridge(getServiceProxy("telegram"));
	const proxy = URL.parse(bridge.url);
	if (!proxy) {
		await bridge.close();
		throw new Error("Telegram proxy bridge returned an invalid address");
	}
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "PI_TELEGRAM_ENV"])
		if (process.env[key] !== undefined) env[key] = process.env[key];
	Object.assign(env, {
		MCP_TRANSPORT: "http",
		MCP_HOST: "127.0.0.1",
		MCP_PORT: "8765",
		TELEGRAM_EXPOSED_TOOLS: "read-only+download_media",
		TELEGRAM_ALLOWED_ROOTS: root,
		TELEGRAM_SESSION_LOCK: "exclusive",
		TELEGRAM_PROXY_TYPE: "http",
		TELEGRAM_PROXY_HOST: proxy.hostname,
		TELEGRAM_PROXY_PORT: proxy.port,
		TELEGRAM_PROXY_RDNS: "true",
	});
	const child = spawn(process.env.PI_TELEGRAM_PYTHON || "python3", [getTelegramServiceScriptPath()], {
		env,
		stdio: ["ignore", "ignore", "ignore"],
	});
	const stop = () => child.kill("SIGTERM");
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		return await new Promise<number>((resolve) => {
			child.once("error", () => resolve(1));
			child.once("exit", (code, signal) => resolve(signal ? 0 : (code ?? 1)));
		});
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await bridge.close();
	}
}
