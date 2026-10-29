// exercises Zed's SQLite workspace and selection schema with an isolated database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { buildPromptContext, readZedState } from "../src/extensions/zed/state.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("reads the active workspace and selected text without opening another workspace", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-zed-"));
	directories.push(directory);
	const path = join(directory, "db.sqlite");
	const db = new DatabaseSync(path);
	db.exec(
		"create table workspaces (workspace_id integer, paths text, timestamp text); create table panes (pane_id integer, workspace_id integer, active integer); create table items (item_id integer, workspace_id integer, pane_id integer, kind text, active integer); create table editors (item_id integer, workspace_id integer, buffer_path text, contents text); create table editor_selections (editor_id integer, workspace_id integer, start integer, end integer)",
	);
	db.prepare("insert into workspaces values (1, ?, '2026')").run(directory);
	db.exec("insert into panes values (1, 1, 1); insert into items values (1, 1, 1, 'Editor', 1)");
	db.prepare("insert into editors values (1, 1, ?, ?)").run(join(directory, "a.ts"), "one\ntwo\nthree\n");
	db.exec("insert into editor_selections values (1, 1, 4, 8)");
	db.close();
	const state = await readZedState({ dbPath: path, cwd: directory });
	expect(state.activeFile).toBe(join(directory, "a.ts"));
	expect(state.openFiles).toEqual([join(directory, "a.ts")]);
	expect(state.selections[0].text).toBe("two\n");
	expect(buildPromptContext(state)).toContain('2 | "two"');
	expect((await readZedState({ dbPath: path, cwd: "/unrelated" })).unavailableReason).toBe("no matching workspace");
});
