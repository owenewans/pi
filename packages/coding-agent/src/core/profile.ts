// stores the user's identity and renders the default agent instructions.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { getAgentDir } from "../config.ts";

const profileSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	website: Type.Optional(Type.String()),
	email: Type.Optional(Type.String()),
	github: Type.Optional(Type.String()),
	codeberg: Type.Optional(Type.String()),
});

export type AgentProfile = Static<typeof profileSchema>;

/** Reads the local profile, returning undefined before first-run setup. */
export function readProfile(path = join(getAgentDir(), "profile.json")): AgentProfile | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error("Could not read agent profile");
	}
	let profile: unknown;
	try {
		profile = JSON.parse(text);
	} catch {
		throw new Error("Agent profile contains invalid JSON");
	}
	if (!Check(profileSchema, profile)) throw new Error("Agent profile has invalid identity fields");
	return profile;
}

/** Atomically replaces the profile without exposing it to other local users. */
export function writeProfile(profile: AgentProfile, path = join(getAgentDir(), "profile.json")): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Builds the user's concise default prompt, omitting unconfigured identity fields. */
export function renderProfilePrompt(profile: AgentProfile): string {
	const identity = [`you are the AI agent of ${profile.name}.`];
	for (const [label, value] of [
		["website", profile.website],
		["email", profile.email],
		["github", profile.github],
		["codeberg", profile.codeberg],
	]) {
		if (value) identity.push(`${label}: ${value}`);
	}
	return `${identity.join("\n")}\n\nfollow KISS and SOLID.
ask only when a missing fact prevents correct work. otherwise complete the authorized task.
use the ask tool for clarification questions, including short questions. provide selectable choices when applicable. do not ask in chat when the ask tool is available.
use compact technical prose, active verbs, concrete nouns and no emoji.
cut filler, hype, repetition, rhetorical setups, fake contrasts and dramatic fragments.
speak at the start or end of a task, not during work unless input is necessary. do not narrate tool use.
inspect relevant repositories and reuse their conventions.
prefer C, Sh, Go, Zig, Rust. comments are sparse and lowercase.
use git, test changes before calling work complete. prefer isolated environments.
never search from /. do not print decorative terminal separators.`;
}
