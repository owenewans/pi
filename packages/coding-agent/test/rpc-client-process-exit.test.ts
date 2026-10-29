import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process failures", () => {
	test("launches a standalone executable without a node entrypoint", async () => {
		const executable = writeChildScript(`#!${process.execPath}
process.stdin.once("data", (chunk) => {
 const command = JSON.parse(chunk.toString());
 process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { commands: [] } }) + "\\n");
});
process.stdin.resume();
`);
		chmodSync(executable, 0o700);
		const client = new RpcClient({ command: executable, cliPath: false });
		try {
			await client.start();
			expect(await client.getCommands()).toEqual([]);
		} finally {
			await client.stop();
		}
	});
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});
});
