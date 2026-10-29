// starts a disposable localhost sshd with isolated host keys, identity and client configuration.
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const SSHD = existsSync("/usr/sbin/sshd")
	? "/usr/sbin/sshd"
	: existsSync("/usr/bin/sshd")
		? "/usr/bin/sshd"
		: undefined;

/** Allocate a test-only loopback port. */
export async function freeSshTestPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture port did not bind");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

/** Start an isolated SSH endpoint and a PATH wrapper that selects only its configuration. */
export async function createSshFixture() {
	if (!SSHD) throw new Error("sshd is not installed");
	const root = await mkdtemp(join(tmpdir(), "pi-ssh-integration-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	const hostKey = join(root, "host-key");
	const clientKey = join(root, "client-key");
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
	await writeFile(join(root, "authorized_keys"), await readFile(`${clientKey}.pub`));
	await writeFile(join(root, "known_hosts"), `pi-fixture ${await readFile(`${hostKey}.pub`, "utf8")}`);
	const port = await freeSshTestPort();
	const serverConfig = join(root, "sshd_config");
	await writeFile(
		serverConfig,
		[
			`Port ${port}`,
			"ListenAddress 127.0.0.1",
			`HostKey ${hostKey}`,
			`AuthorizedKeysFile ${join(root, "authorized_keys")}`,
			`PidFile ${join(root, "sshd.pid")}`,
			"PasswordAuthentication no",
			"KbdInteractiveAuthentication no",
			"StrictModes no",
			"AllowTcpForwarding yes",
			"",
		].join("\n"),
	);
	const config = join(root, "ssh_config");
	await writeFile(
		config,
		[
			"Host fixture",
			"  HostName 127.0.0.1",
			`  Port ${port}`,
			`  User ${userInfo().username}`,
			`  IdentityFile ${clientKey}`,
			"  IdentitiesOnly yes",
			`  UserKnownHostsFile ${join(root, "known_hosts")}`,
			"  HostKeyAlias pi-fixture",
			"  StrictHostKeyChecking yes",
			"  GlobalKnownHostsFile /dev/null",
			"",
		].join("\n"),
	);
	const realSsh = execFileSync("sh", ["-c", "command -v ssh"], { encoding: "utf8" }).trim();
	await writeFile(
		join(bin, "ssh"),
		`#!${process.execPath}\nconst { spawn } = require('node:child_process'); const child = spawn(${JSON.stringify(realSsh)}, ['-F', ${JSON.stringify(config)}, ...process.argv.slice(2)], { stdio: 'inherit' }); child.on('error', () => process.exit(255)); child.on('exit', (code) => process.exit(code ?? 255));\n`,
		{ mode: 0o700 },
	);
	const daemon = spawn(SSHD, ["-D", "-e", "-f", serverConfig], { stdio: ["ignore", "ignore", "pipe"] });
	let diagnostic = "";
	daemon.stderr.on("data", (chunk: Buffer) => {
		if (diagnostic.length < 4096) diagnostic += chunk.toString();
	});
	try {
		for (let attempt = 0; ; attempt++) {
			if (daemon.exitCode !== null || attempt === 100) throw new Error(`fixture sshd did not start: ${diagnostic}`);
			const ready = await new Promise<boolean>((resolve) => {
				const socket = net.connect(port, "127.0.0.1");
				socket.once("connect", () => {
					socket.destroy();
					resolve(true);
				});
				socket.once("error", () => resolve(false));
			});
			if (ready) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return {
			root,
			bin,
			close: async () => {
				const exited = new Promise<void>((resolve) => daemon.once("close", () => resolve()));
				daemon.kill();
				await exited;
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		daemon.kill();
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
