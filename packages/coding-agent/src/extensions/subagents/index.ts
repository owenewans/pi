// runs isolated agent contexts through the current model runtime.
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext } from "../../core/extensions/types.ts";
import { createCodingTools, createReadOnlyTools } from "../../core/tools/index.ts";
import { LanguageServers } from "../code/lsp.ts";

const ROLE_PROMPTS = {
	scout: "Investigate the assigned task. Read relevant files and report concrete findings with paths. Do not edit files.",
	reviewer:
		"Review the assigned change. Report actionable defects with paths and evidence, ordered by severity. Do not edit files.",
	worker:
		"Implement the assigned task. Inspect relevant code, test changes and report results and remaining problems.",
} as const;
type Task = { role: keyof typeof ROLE_PROMPTS; task: string };

/** Register bounded parallel subagents with independent conversation contexts. */
export default function subagentsExtension(pi: ExtensionAPI): void {
	const running = new Set<Agent>();
	const pending = new Set<Promise<unknown>>();
	pi.on("session_shutdown", async () => {
		for (const agent of running) agent.abort();
		await Promise.allSettled([...pending]);
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagents",
		description:
			"Run up to four independent subagents in parallel using the current model and working directory. Provide each a self-contained task: subagents do not see the parent conversation. scout and reviewer have read-only file tools; worker can read, execute commands and edit files. Workers share the current filesystem, so assign non-overlapping changes. Results return when all agents finish; cancelling aborts them.",
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					role: Type.Union([Type.Literal("scout"), Type.Literal("reviewer"), Type.Literal("worker")]),
					task: Type.String({ minLength: 1 }),
				}),
				{ minItems: 1, maxItems: 4 },
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!ctx.model) throw new Error("No model selected for subagents");
			const results = await Promise.all(
				params.tasks.map((task) => {
					const job = runTask(task, ctx, running, signal);
					pending.add(job);
					void job.then(
						() => pending.delete(job),
						() => pending.delete(job),
					);
					return job;
				}),
			);
			return {
				content: [{ type: "text", text: JSON.stringify(results) }],
				details: { results },
				isError: results.some((result) => result.status !== "completed"),
			};
		},
	});
}

async function runTask(task: Task, ctx: ExtensionToolContext, running: Set<Agent>, signal?: AbortSignal) {
	if (!ctx.model) throw new Error("No model selected for subagent");
	signal?.throwIfAborted();
	const servers = new LanguageServers();
	const agent = new Agent({
		initialState: {
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel ?? "off",
			systemPrompt: `${ctx.getSystemPrompt()}\n\nYou are a subagent. ${ROLE_PROMPTS[task.role]} Do not delegate; return findings to the parent.`,
			tools: task.role === "worker" ? createCodingTools(ctx.cwd) : createReadOnlyTools(ctx.cwd),
		},
		streamFn: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
		sessionId: randomUUID(),
		afterToolCall: async ({ toolCall, args, isError, result: toolResult }, toolSignal) => {
			if (
				isError ||
				!["write", "edit"].includes(toolCall.name) ||
				!args ||
				typeof args !== "object" ||
				!("path" in args) ||
				typeof args.path !== "string" ||
				!servers.supports(args.path)
			)
				return;
			try {
				const result = await servers.diagnostics(args.path, ctx.cwd, toolSignal);
				return {
					content: [
						...toolResult.content,
						{
							type: "text",
							text: `Language-server diagnostics: ${result.confirmed ? JSON.stringify(result.diagnostics) : "not confirmed"}`,
						},
					],
				};
			} catch {
				return {
					content: [...toolResult.content, { type: "text", text: "Language-server diagnostics unavailable" }],
				};
			}
		},
	});
	running.add(agent);
	const abort = () => agent.abort();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) throw signal.reason;
		await agent.prompt(task.task);
		const message = agent.state.messages.findLast((item) => item.role === "assistant");
		if (!message || message.role !== "assistant")
			return { role: task.role, status: "failed", output: "No assistant response" };
		const output = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return {
			role: task.role,
			status: message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "completed",
			output: (message.errorMessage || output).slice(0, 50_000),
		};
	} finally {
		signal?.removeEventListener("abort", abort);
		running.delete(agent);
		await servers.close();
	}
}
