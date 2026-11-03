import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProfile, renderProfilePrompt, writeProfile } from "../src/core/profile.ts";

let directory: string;
let path: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-profile-"));
	path = join(directory, "profile.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("agent profile", () => {
	it("returns undefined before setup", () => {
		expect(readProfile(path)).toBeUndefined();
	});

	it("writes and replaces a private profile without leftover temporary files", () => {
		writeProfile({ name: "fixture", github: "github.com/example" }, path);
		expect(readProfile(path)).toEqual({ name: "fixture", github: "github.com/example" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		writeProfile({ name: "changed" }, path);
		expect(readProfile(path)).toEqual({ name: "changed" });
		expect(readdirSync(directory)).toEqual(["profile.json"]);
		expect(readFileSync(path, "utf8")).toContain("changed");
	});

	it.each(["null", "[]", "{}", '{"name":""}', '{"name":5}', '{"name":"valid","email":5}'])(
		"rejects invalid stored profiles: %s",
		(text) => {
			writeFileSync(path, text);
			expect(() => readProfile(path)).toThrow("invalid identity fields");
		},
	);

	it("does not expose malformed file contents in errors", () => {
		writeFileSync(path, "private malformed data");
		expect(() => readProfile(path)).toThrow(/^Agent profile contains invalid JSON$/);
	});

	it("renders only configured identity fields without duplicating skill instructions", () => {
		const prompt = renderProfilePrompt({
			name: "fixture",
			website: "example.org",
			email: "user@example.org",
			github: "github.com/example",
			codeberg: "codeberg.org/example",
		});
		expect(prompt).toBe(
			[
				"you are the AI agent of fixture.",
				"website: example.org",
				"email: user@example.org",
				"github: github.com/example",
				"codeberg: codeberg.org/example",
			].join("\n"),
		);
		expect(renderProfilePrompt({ name: "fixture" })).toBe("you are the AI agent of fixture.");
	});
});
