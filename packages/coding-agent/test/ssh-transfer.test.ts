// transfers real binary files through a disposable local OpenSSH server.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { transferSsh } from "../src/extensions/ssh/transfer.ts";
import { createSshFixture, SSHD } from "./ssh-fixture.ts";

let fixture: Awaited<ReturnType<typeof createSshFixture>>;
describe.skipIf(!SSHD)("SSH binary transfers", () => {
	beforeAll(async () => {
		fixture = await createSshFixture();
	});
	beforeEach(() => {
		vi.stubEnv("PATH", `${fixture.bin}:${process.env.PATH}`);
	});
	afterAll(async () => {
		vi.unstubAllEnvs();
		await fixture?.close();
	});

	it("round-trips binary files with spaces and shell punctuation", async () => {
		const source = join(fixture.root, "source ' ; binary");
		const remote = join(fixture.root, "remote ' ; binary");
		const destination = join(fixture.root, "download binary");
		const content = randomBytes(512 * 1024);
		await writeFile(source, content);
		const upload = await transferSsh(
			{ host: "fixture", direction: "upload", localPath: source, remotePath: remote },
			fixture.root,
		);
		expect(upload.archiveBytes).toBeGreaterThan(content.length);
		expect(await readFile(remote)).toEqual(content);
		await transferSsh(
			{ host: "fixture", direction: "download", localPath: destination, remotePath: remote },
			fixture.root,
		);
		expect(await readFile(destination)).toEqual(content);
	}, 30_000);

	it("preserves existing destinations unless overwrite was requested", async () => {
		const source = join(fixture.root, "overwrite-source");
		const remote = join(fixture.root, "overwrite-remote");
		const destination = join(fixture.root, "overwrite-download");
		await writeFile(source, "replacement");
		await writeFile(remote, "original remote");
		await writeFile(destination, "original local");
		await expect(
			transferSsh({ host: "fixture", direction: "upload", localPath: source, remotePath: remote }, fixture.root),
		).rejects.toThrow("destination exists");
		expect(await readFile(remote, "utf8")).toBe("original remote");
		await transferSsh(
			{ host: "fixture", direction: "upload", localPath: source, remotePath: remote, overwrite: true },
			fixture.root,
		);
		expect(await readFile(remote, "utf8")).toBe("replacement");
		await expect(
			transferSsh(
				{ host: "fixture", direction: "download", localPath: destination, remotePath: remote },
				fixture.root,
			),
		).rejects.toThrow("destination exists");
		expect(await readFile(destination, "utf8")).toBe("original local");
		await transferSsh(
			{ host: "fixture", direction: "download", localPath: destination, remotePath: remote, overwrite: true },
			fixture.root,
		);
		expect(await readFile(destination, "utf8")).toBe("replacement");
	}, 30_000);

	it("requires recursive mode and preserves nested files and symlinks without dereferencing them", async () => {
		const source = join(fixture.root, "tree");
		const remote = join(fixture.root, "remote-tree");
		const destination = join(fixture.root, "download-tree");
		await mkdir(join(source, "nested"), { recursive: true });
		await writeFile(join(source, "nested", "file"), "fixture");
		await symlink("nested/file", join(source, "link"));
		await expect(
			transferSsh({ host: "fixture", direction: "upload", localPath: source, remotePath: remote }, fixture.root),
		).rejects.toThrow("recursive");
		await transferSsh(
			{ host: "fixture", direction: "upload", localPath: source, remotePath: remote, recursive: true },
			fixture.root,
		);
		await expect(
			transferSsh(
				{ host: "fixture", direction: "download", localPath: destination, remotePath: remote },
				fixture.root,
			),
		).rejects.toThrow("recursive");
		await transferSsh(
			{ host: "fixture", direction: "download", localPath: destination, remotePath: remote, recursive: true },
			fixture.root,
		);
		expect(await readFile(join(destination, "nested", "file"), "utf8")).toBe("fixture");
		expect((await lstat(join(destination, "link"))).isSymbolicLink()).toBe(true);
		expect((await readdir(fixture.root)).some((name) => name.startsWith(".pi-transfer"))).toBe(false);
	}, 30_000);

	it("honors pre-cancellation and cleans staging after a missing remote file", async () => {
		await expect(
			transferSsh(
				{
					host: "fixture",
					direction: "download",
					localPath: "missing-download",
					remotePath: join(fixture.root, "absent"),
				},
				fixture.root,
				AbortSignal.abort(new Error("cancelled")),
			),
		).rejects.toThrow("cancelled");
		await expect(
			transferSsh(
				{
					host: "fixture",
					direction: "download",
					localPath: "missing-download",
					remotePath: join(fixture.root, "absent"),
				},
				fixture.root,
			),
		).rejects.toThrow();
		expect((await readdir(fixture.root)).some((name) => name.startsWith(".pi-transfer"))).toBe(false);
	}, 30_000);
});
