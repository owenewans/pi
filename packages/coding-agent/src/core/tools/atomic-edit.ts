// publishes editor replacements without losing concurrent in-process or external file changes.
import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { withFileMutationQueue } from "./file-mutation-queue.ts";

/** Replace an existing file only while its full bytes still match the read version. */
export function replaceFileContents(
	path: string,
	expected: Buffer,
	replacement: Buffer,
	signal?: AbortSignal,
): Promise<void> {
	return withFileMutationQueue(path, async () => {
		signal?.throwIfAborted();
		const target = await realpath(path);
		const metadata = await stat(target);
		if (!(await readFile(target)).equals(expected)) throw new Error("File changed since it was read; read it again");
		const temporary = `${target}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, replacement, { mode: metadata.mode & 0o777, flag: "wx" });
			signal?.throwIfAborted();
			if (!(await readFile(target)).equals(expected)) throw new Error("File changed during edit; read it again");
			await rename(temporary, target);
		} finally {
			await rm(temporary, { force: true });
		}
	});
}
