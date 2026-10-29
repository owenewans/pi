// checks private persistent browser mode settings without starting a browser.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBrowserMode, writeBrowserMode } from "../src/core/browser-settings.ts";

let directory: string;
let path: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-browser-settings-"));
	path = join(directory, "browser.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("browser mode persistence", () => {
	it("returns undefined before setup", () => expect(readBrowserMode(path)).toBeUndefined());
	it.each(["headless", "headed", "xvfb"] as const)("persists %s privately", (mode) => {
		writeBrowserMode(mode, path);
		expect(readBrowserMode(path)).toBe(mode);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mode });
	});
	it.each(["not JSON", "{}", '{"mode":"invalid"}'])("rejects invalid settings: %s", (value) => {
		writeFileSync(path, value);
		expect(() => readBrowserMode(path)).toThrow();
	});
});
