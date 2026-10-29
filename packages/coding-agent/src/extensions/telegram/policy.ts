// limits the Telegram bridge to audited message reads and bounded local downloads.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const READ_TOOLS = new Set([
	"get_chats",
	"list_chats",
	"get_chat",
	"list_topics",
	"get_full_chat",
	"get_messages",
	"list_messages",
	"get_message_context",
	"search_messages",
	"get_history",
	"get_pinned_messages",
	"get_media_info",
	"get_me",
]);

/** Check an explicit allowlist; server readOnly annotations cannot grant extra operations. */
export function isTelegramReadTool(name: string): boolean {
	return READ_TOOLS.has(name) || name === "download_media";
}

/** Constrain download destinations to private top-level files in ~/Downloads/telegram. */
export async function telegramDownloadArgs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const root = join(homedir(), "Downloads", "telegram");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const canonicalRoot = await realpath(root);
	const requested = args.file_path;
	if (requested !== undefined && (typeof requested !== "string" || !requested || requested.includes("\0")))
		throw new Error("Invalid Telegram download filename");
	const target = resolve(root, typeof requested === "string" ? requested : `telegram-${randomUUID()}`);
	if (dirname(target) !== resolve(root))
		throw new Error("Telegram downloads must be top-level files in ~/Downloads/telegram");
	const destination = join(canonicalRoot, basename(target));
	try {
		if ((await lstat(destination)).isSymbolicLink())
			throw new Error("Telegram download cannot replace a symbolic link");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	return { ...args, file_path: destination };
}
