// persists the browser display mode independently of account identity.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

export type BrowserMode = "headed" | "headless" | "xvfb";

/** Read the saved browser mode, or undefined before setup. */
export function readBrowserMode(path = join(getAgentDir(), "browser.json")): BrowserMode | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error("Could not read browser mode");
	}
	let mode: unknown;
	try {
		const settings: unknown = JSON.parse(text);
		mode = typeof settings === "object" && settings !== null && "mode" in settings ? settings.mode : undefined;
	} catch {
		throw new Error("Browser settings contain invalid JSON");
	}
	if (mode !== "headed" && mode !== "headless" && mode !== "xvfb") throw new Error("Invalid browser mode");
	return mode;
}

/** Atomically persist a browser mode with private file permissions. */
export function writeBrowserMode(mode: BrowserMode, path = join(getAgentDir(), "browser.json")): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ mode })}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
