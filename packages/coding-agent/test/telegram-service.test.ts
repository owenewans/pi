// tests service proxy isolation without a Telegram account.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { applyHttpProxySettings } from "../src/core/http-dispatcher.ts";
import { runTelegramService } from "../src/extensions/telegram/service.ts";

let directory = "";
afterEach(() => {
	applyHttpProxySettings(undefined);
	vi.unstubAllEnvs();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

it("passes only an owned local bridge to the service process", async () => {
	directory = mkdtempSync(join(tmpdir(), "pi-telegram-service-"));
	const executable = join(directory, "python");
	writeFileSync(
		executable,
		`#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(process.env.HOME + '/result.json', JSON.stringify({ host: process.env.TELEGRAM_PROXY_HOST, port: process.env.TELEGRAM_PROXY_PORT, mode: process.env.TELEGRAM_EXPOSED_TOOLS, secret: Object.values(process.env).some(value => value.includes('fixture-secret')) }));\n`,
	);
	chmodSync(executable, 0o700);
	vi.stubEnv("HOME", directory);
	vi.stubEnv("PI_TELEGRAM_PYTHON", executable);
	vi.stubEnv("API_FIXTURE_SECRET", "fixture-secret");
	applyHttpProxySettings("socks5h://fixture-user:fixture-secret@127.0.0.1:1234");
	expect(await runTelegramService()).toBe(0);
	const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
	expect(result).toMatchObject({ host: "127.0.0.1", mode: "read-only+download_media", secret: false });
	expect(Number(result.port)).toBeGreaterThan(0);
});
