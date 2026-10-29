// exposes remote shell and file operations using OpenSSH aliases and keys.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { quoteRemote, runSsh, type SshTarget } from "./client.ts";
import { transferSsh } from "./transfer.ts";
import { SshTunnels } from "./tunnels.ts";

const targetFields = {
	host: Type.String({ minLength: 1 }),
	port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
};

export default function sshExtension(pi: ExtensionAPI): void {
	let tunnels = new SshTunnels();
	pi.on("session_start", async () => {
		await tunnels.closeAll();
		tunnels = new SshTunnels();
	});
	pi.on("session_shutdown", () => tunnels.closeAll());
	pi.registerTool({
		name: "ssh_transfer",
		label: "SSH transfer",
		description:
			"Copy a file or directory between this machine and an SSH host using binary archive streams. Requires tar and GNU mv on both Linux hosts. Paths name exact destinations, not container directories. recursive is required for directories. Existing destinations are preserved unless overwrite is true; nonempty directories are never merged. Uses SSH config aliases, keys and jumps; no interactive passwords.",
		parameters: Type.Object({
			...targetFields,
			direction: Type.Union([Type.Literal("upload"), Type.Literal("download")]),
			localPath: Type.String({ minLength: 1 }),
			remotePath: Type.String({ minLength: 1 }),
			recursive: Type.Optional(Type.Boolean()),
			overwrite: Type.Optional(Type.Boolean()),
			timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await transferSsh({ ...params, timeoutMs: (params.timeout ?? 300) * 1000 }, ctx.cwd, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerTool({
		name: "ssh_tunnel",
		label: "SSH forwarding",
		description:
			"Open, list or close owned local, remote or dynamic SOCKS SSH forwardings. List/close require no host; open requires host, type and bindPort; local/remote also require destinationHost and destinationPort. bindHost defaults to 127.0.0.1. Only this session's forwardings can be closed; all close at session shutdown.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("open"), Type.Literal("list"), Type.Literal("close")]),
			host: Type.Optional(Type.String()),
			port: targetFields.port,
			id: Type.Optional(Type.String()),
			type: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote"), Type.Literal("dynamic")])),
			bindHost: Type.Optional(Type.String()),
			bindPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
			destinationHost: Type.Optional(Type.String()),
			destinationPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
		}),
		async execute(_id, params, signal) {
			if (params.action === "list")
				return { content: [{ type: "text", text: JSON.stringify(tunnels.list()) }], details: {} };
			if (params.action === "close") {
				if (!params.id) throw new Error("SSH tunnel close requires id");
				await tunnels.close(params.id);
				return { content: [{ type: "text", text: "SSH tunnel closed" }], details: {} };
			}
			if (!params.host || !params.type || params.bindPort === undefined)
				throw new Error("SSH tunnel open requires host, type and bindPort");
			const result = await tunnels.open(
				{ ...params, host: params.host, type: params.type, bindPort: params.bindPort },
				signal,
			);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		},
	});
	pi.registerTool({
		name: "ssh_bash",
		label: "SSH command",
		description:
			"Run a remote shell command through OpenSSH. host accepts user@host or ~/.ssh/config aliases; keys, ProxyJump and ProxyCommand use the user's SSH configuration. No interactive password prompts.",
		parameters: Type.Object({
			...targetFields,
			command: Type.String({ minLength: 1 }),
			cwd: Type.Optional(Type.String()),
			timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
		}),
		async execute(_id, params, signal) {
			const command = params.cwd ? `cd -- ${quoteRemote(params.cwd)} && ${params.command}` : params.command;
			const result = await runSsh(params, command, { signal, timeoutMs: (params.timeout ?? 60) * 1000 });
			return {
				content: [
					{
						type: "text",
						text: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}\nexit code: ${result.code}`,
					},
				],
				details: result,
				isError: result.code !== 0,
			};
		},
	});
	pi.registerTool({
		name: "ssh_read",
		label: "SSH read",
		description:
			"Read a remote text file or list a remote directory. Paths resolve against the remote login directory. Output defaults to 2000 lines.",
		parameters: Type.Object({
			...targetFields,
			path: Type.String({ minLength: 1 }),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
		}),
		async execute(_id, params, signal) {
			const path = quoteRemote(params.path);
			const start = params.offset ?? 1;
			const end = start + (params.limit ?? 2000) - 1;
			const result = await runSsh(
				params,
				`if [ -d ${path} ]; then ls -la -- ${path}; else sed -n ${quoteRemote(`${start},${end}p`)} -- ${path}; fi`,
				{ signal },
			);
			if (result.code !== 0) throw new Error(result.stderr.trim() || "Remote read failed");
			return { content: [{ type: "text", text: result.stdout }], details: {} };
		},
	});
	pi.registerTool({
		name: "ssh_write",
		label: "SSH write",
		description:
			"Atomically write a remote UTF-8 file, creating parent directories and preserving an existing file's permissions.",
		parameters: Type.Object({ ...targetFields, path: Type.String({ minLength: 1 }), content: Type.String() }),
		async execute(_id, params, signal) {
			await writeRemote(params, params.path, params.content, signal);
			return { content: [{ type: "text", text: `Wrote ${params.path}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "ssh_edit",
		label: "SSH edit",
		description:
			"Replace one unique exact-text match in a remote UTF-8 file. Refuses to overwrite a file changed since this operation read it.",
		parameters: Type.Object({
			...targetFields,
			path: Type.String({ minLength: 1 }),
			oldText: Type.String({ minLength: 1 }),
			newText: Type.String(),
		}),
		async execute(_id, params, signal) {
			const original = await runSsh(params, `cat -- ${quoteRemote(params.path)}`, { signal });
			if (original.code !== 0) throw new Error(original.stderr.trim() || "Remote read failed");
			const index = original.stdout.indexOf(params.oldText);
			if (index < 0) throw new Error("Remote edit target not found");
			if (original.stdout.indexOf(params.oldText, index + 1) >= 0)
				throw new Error("Remote edit target is not unique");
			const content =
				original.stdout.slice(0, index) + params.newText + original.stdout.slice(index + params.oldText.length);
			const expected = createHash("sha256").update(original.stdout).digest("hex");
			await writeRemote(params, params.path, content, signal, expected);
			return { content: [{ type: "text", text: `Edited ${params.path}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "ssh_grep",
		label: "SSH search",
		description:
			"Search remote file contents using ripgrep. Pattern is data, not a shell command. Requires rg on the remote host.",
		parameters: Type.Object({
			...targetFields,
			pattern: Type.String(),
			path: Type.Optional(Type.String()),
			glob: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal) {
			const glob = params.glob ? `-g ${quoteRemote(params.glob)} ` : "";
			const result = await runSsh(
				params,
				`rg -n --max-count 100 ${glob}-- ${quoteRemote(params.pattern)} ${quoteRemote(params.path ?? ".")}`,
				{ signal },
			);
			if (result.code > 1) throw new Error(result.stderr.trim() || "Remote search failed");
			return { content: [{ type: "text", text: result.stdout || "no matches" }], details: {} };
		},
	});
	pi.registerTool({
		name: "ssh_glob",
		label: "SSH files",
		description: "Find remote files by glob using ripgrep, respecting ignore files. Requires rg on the remote host.",
		parameters: Type.Object({ ...targetFields, pattern: Type.String(), path: Type.Optional(Type.String()) }),
		async execute(_id, params, signal) {
			const result = await runSsh(
				params,
				`rg --files -g ${quoteRemote(params.pattern)} -- ${quoteRemote(params.path ?? ".")}`,
				{ signal },
			);
			if (result.code > 1) throw new Error(result.stderr.trim() || "Remote file search failed");
			return { content: [{ type: "text", text: result.stdout || "no files" }], details: {} };
		},
	});
}

/** Writes via a same-directory temporary file, optionally checking the read version. */
export async function writeRemote(
	target: SshTarget,
	path: string,
	content: string,
	signal?: AbortSignal,
	expectedHash?: string,
): Promise<void> {
	const directory = posix.dirname(path);
	const script = [
		"set -eu",
		`destination=${quoteRemote(path)}`,
		`directory=${quoteRemote(directory)}`,
		'mkdir -p -- "$directory"',
		"umask 077",
		'temporary=$(mktemp "$directory/.pi-write.XXXXXX")',
		`trap 'rm -f -- "$temporary"' EXIT HUP INT TERM`,
		'cat > "$temporary"',
	];
	if (expectedHash)
		script.push(
			'actual=$(sha256sum < "$destination")',
			`[ "\${actual%% *}" = ${quoteRemote(expectedHash)} ] || { echo "remote file changed during edit" >&2; exit 74; }`,
		);
	script.push(
		'if [ -f "$destination" ]; then chmod --reference="$destination" -- "$temporary"; fi',
		'mv -f -- "$temporary" "$destination"',
	);
	const result = await runSsh(target, script.join("\n"), { input: content, signal });
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Remote write failed");
}
