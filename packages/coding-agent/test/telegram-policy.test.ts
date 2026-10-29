// verifies Telegram read-only policy and local download boundaries without an account.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTelegramReadTool, telegramDownloadArgs } from "../src/extensions/telegram/policy.ts";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pi-telegram-policy-"));
	vi.stubEnv("HOME", home);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("Telegram read-only policy", () => {
	it.each(["get_messages", "search_messages", "list_chats", "get_me", "download_media"])("allows %s", (name) =>
		expect(isTelegramReadTool(name)).toBe(true),
	);
	it.each([
		"send_message",
		"edit_message",
		"delete_messages",
		"reply_to_message",
		"join_chat",
		"export_chat_invite",
		"get_invite_link",
		"unknown",
	])("blocks %s regardless of metadata", (name) => expect(isTelegramReadTool(name)).toBe(false));
	it("chooses a private download destination and preserves read arguments", async () => {
		const args = await telegramDownloadArgs({ chat_id: "fixture", message_id: 12 });
		expect(args.chat_id).toBe("fixture");
		expect(args.message_id).toBe(12);
		expect(args.file_path).toEqual(
			expect.stringMatching(new RegExp(`^${join(home, "Downloads/telegram/telegram-")}`)),
		);
	});
	it("accepts a named top-level file", async () => {
		expect((await telegramDownloadArgs({ file_path: "fixture.pdf" })).file_path).toBe(
			join(home, "Downloads/telegram/fixture.pdf"),
		);
	});
	it.each(["../escape", "/tmp/escape", "subdir/file", "bad\0name", ""])(
		"blocks invalid download path %j",
		async (path) => {
			await expect(telegramDownloadArgs({ file_path: path })).rejects.toThrow();
		},
	);
	it("blocks a download destination symlink", async () => {
		await telegramDownloadArgs({ file_path: "prepare" });
		symlinkSync(join(home, "outside"), join(home, "Downloads/telegram/fixture"));
		await expect(telegramDownloadArgs({ file_path: "fixture" })).rejects.toThrow("symbolic link");
	});
});
