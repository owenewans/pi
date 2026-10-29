// exposes session-owned background processes and real Linux PTYs.
import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { ProcessManager } from "./manager.ts";

export default function processesExtension(pi: ExtensionAPI): void {
	let manager: ProcessManager | undefined;
	let disposed = false;
	const getManager = (ctx: ExtensionContext) => {
		manager ??= new ProcessManager(join(getAgentDir(), "processes", ctx.sessionManager.getSessionId()));
		return manager;
	};
	pi.on("session_shutdown", async () => {
		disposed = true;
		await manager?.dispose();
	});
	pi.registerCommand("ps", {
		description: "List this session's background processes",
		handler: async (_args, ctx) => {
			const entries = getManager(ctx).list();
			ctx.ui.notify(
				entries.map((entry) => `${entry.id} ${entry.name}: ${entry.state.kind}`).join("\n") || "no processes",
				"info",
			);
		},
	});
	pi.registerTool({
		name: "process",
		label: "Process",
		description:
			"Start and control background commands. terminal=pty allocates a real Linux PTY with util-linux script. Commands keep running across turns. Read recent output or use the returned logPath for complete output. Completion notifies the agent; do not poll waiting for it. PTY output combines stdout/stderr and may include terminal escapes.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("start"),
				Type.Literal("list"),
				Type.Literal("output"),
				Type.Literal("write"),
				Type.Literal("stop"),
				Type.Literal("clear"),
			]),
			name: Type.Optional(Type.String({ minLength: 1, description: "Required for start." })),
			command: Type.Optional(Type.String({ minLength: 1, description: "Required for start." })),
			cwd: Type.Optional(Type.String()),
			terminal: Type.Optional(Type.Union([Type.Literal("pipe"), Type.Literal("pty")])),
			onSuccess: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("context"), Type.Literal("ignore")])),
			id: Type.Optional(Type.String({ minLength: 1, description: "Required for output, write and stop." })),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
			input: Type.Optional(Type.String()),
			end: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const processes = getManager(ctx);
			let text: string;
			switch (params.action) {
				case "start": {
					// action-dependent requirements cannot use a root schema union on provider APIs.
					if (!params.name || !params.command) throw new Error("start requires name and command");
					const info = await processes.start(
						params.name,
						params.command,
						params.cwd || ctx.cwd,
						params.terminal ?? "pipe",
						(entry) => {
							if (disposed || entry.state.kind === "stopped") return;
							const failed =
								entry.state.kind === "failed" || (entry.state.kind === "exited" && entry.state.code !== 0);
							const mode = failed ? "turn" : (params.onSuccess ?? "context");
							if (mode === "ignore") return;
							pi.sendMessage(
								{
									customType: "process-exit",
									content: `Process ${entry.name} (${entry.id}): ${JSON.stringify(entry.state)}. Log: ${entry.logPath}`,
									display: true,
									details: { id: entry.id, state: entry.state },
								},
								{ triggerTurn: mode === "turn", deliverAs: "followUp" },
							);
						},
					);
					text = JSON.stringify(info);
					break;
				}
				case "list":
					text = JSON.stringify(processes.list());
					break;
				case "output":
					if (!params.id) throw new Error("output requires id");
					text = processes
						.output(params.id)
						.split("\n")
						.slice(-(params.lines ?? 100))
						.join("\n");
					break;
				case "write":
					if (!params.id) throw new Error("write requires id");
					if (!params.input && !params.end) throw new Error("Provide input or end=true");
					await processes.write(params.id, params.input ?? "", params.end ?? false);
					text = "input written";
					break;
				case "stop":
					if (!params.id) throw new Error("stop requires id");
					await processes.stop(params.id);
					text = "process stopped";
					break;
				case "clear":
					processes.clear();
					text = "completed processes cleared";
					break;
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
