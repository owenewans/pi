// runs isolated agent contexts through the current model runtime.
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext } from "../../core/extensions/types.ts";

const ROLE_PROMPTS = {
	scout: "Investigate the assigned task. Read relevant files and report concrete findings with paths. Do not edit files.",
	reviewer:
		"Review the assigned change. Report actionable defects with paths and evidence, ordered by severity. Do not edit files.",
	worker:
		"Implement the assigned task. Inspect relevant code, test changes and report results and remaining problems.",
} as const;
type Task = { role: keyof typeof ROLE_PROMPTS; task: string };
type Result = { role: Task["role"]; status: "completed" | "failed" | "stopped"; output: string };
type Job = {
	id: string;
	role: Task["role"];
	task: string;
	status: "running" | Result["status"];
	controller: AbortController;
	finished: Promise<void>;
	output?: string;
};

/** Register session-owned background agents with independent conversation contexts. */
export default function subagentsExtension(pi: ExtensionAPI): void {
	const jobs = new Map<string, Job>();
	let disposed = false;
	let generation = 0;
	let wakePending = false;
	const info = (job: Job, output = false) => ({
		id: job.id,
		role: job.role,
		task: job.task,
		status: job.status,
		...(output && job.output !== undefined ? { output: job.output } : {}),
	});
	const cancelJobs = async () => {
		generation++;
		wakePending = false;
		const previous = [...jobs.values()];
		jobs.clear();
		for (const job of previous) job.controller.abort();
		await Promise.allSettled(previous.map((job) => job.finished));
	};
	pi.on("session_shutdown", async () => {
		disposed = true;
		await cancelJobs();
	});
	pi.on("session_tree", cancelJobs);
	pi.on("agent_before_settle", (event) => {
		if (!wakePending) return;
		wakePending = false;
		if (event.outcome !== "completed" || event.continue) return;
		return {
			continue: true,
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "subagent-continue",
					content: "Review the completed subagent results and continue the authorized task.",
					display: false,
				},
			],
		};
	});
	// an explicit parent interrupt wins; completed results remain in the transcript.
	pi.on("agent_settled", (event) => {
		const wake = wakePending && !event.aborted;
		wakePending = false;
		if (wake)
			pi.sendMessage(
				{
					customType: "subagent-continue",
					content: "Review the completed subagent results and continue the authorized task.",
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
	});
	pi.registerTool({
		name: "subagent",
		label: "Subagents",
		description:
			"Start background subagents and return IDs immediately so you can continue your own work. Completion delivers results automatically and wakes the parent; do not poll waiting for it. Use action=list, result or stop to inspect or cancel jobs; clear removes finished jobs. At most four agents run per session. Provide self-contained tasks: subagents do not see the parent conversation. scout and reviewer have read-only file tools; worker can read, execute commands and edit files. Workers share the filesystem, so assign non-overlapping changes. Jobs survive parent turns and interrupts, but stop on branch changes and session shutdown.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([
					Type.Literal("start"),
					Type.Literal("list"),
					Type.Literal("result"),
					Type.Literal("stop"),
					Type.Literal("clear"),
				]),
			),
			id: Type.Optional(Type.String({ minLength: 1, description: "Required for result and stop." })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						role: Type.Union([Type.Literal("scout"), Type.Literal("reviewer"), Type.Literal("worker")]),
						task: Type.String({ minLength: 1 }),
					}),
					{ minItems: 1, maxItems: 4 },
				),
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (disposed) throw new Error("Subagent session has shut down");
			let results: ReturnType<typeof info>[];
			switch (params.action ?? "start") {
				case "start": {
					if (!params.tasks?.length) throw new Error("start requires tasks");
					if (!ctx.model) throw new Error("No model selected for subagents");
					const active = [...jobs.values()].filter((job) => job.status === "running").length;
					if (active + params.tasks.length > 4) throw new Error("At most four subagents can run per session");
					for (const [id, job] of jobs) {
						if (jobs.size + params.tasks.length <= 32) break;
						if (job.status !== "running") jobs.delete(id);
					}
					const owner = generation;
					results = params.tasks.map((task) => {
						const job: Job = {
							id: randomUUID(),
							...task,
							status: "running",
							controller: new AbortController(),
							finished: Promise.resolve(),
						};
						jobs.set(job.id, job);
						job.finished = (async () => {
							let result: Result;
							try {
								result = await runTask(task, ctx, job.controller.signal);
							} catch (error) {
								result = { role: task.role, status: "failed", output: String(error).slice(0, 50_000) };
							}
							job.status = job.controller.signal.aborted ? "stopped" : result.status;
							job.output = result.output;
							if (disposed || owner !== generation || job.status === "stopped") return;
							const idle = ctx.isIdle();
							wakePending ||= !idle;
							pi.sendMessage(
								{
									customType: "subagent-result",
									content: JSON.stringify(info(job, true)),
									display: true,
									details: info(job, true),
								},
								{ triggerTurn: idle, deliverAs: "followUp" },
							);
						})();
						// keep notification failures from becoming unhandled rejections.
						void job.finished.catch(() => {});
						return info(job);
					});
					break;
				}
				case "list":
					results = [...jobs.values()].map((job) => info(job));
					break;
				case "clear":
					for (const [id, job] of jobs) if (job.status !== "running") jobs.delete(id);
					results = [...jobs.values()].map((job) => info(job));
					break;
				case "result":
				case "stop": {
					if (!params.id) throw new Error(`${params.action} requires id`);
					const job = jobs.get(params.id);
					if (!job) throw new Error(`Unknown subagent: ${params.id}`);
					if (params.action === "stop" && job.status === "running") {
						job.controller.abort();
						await job.finished;
					}
					results = [info(job, true)];
					break;
				}
			}
			return { content: [{ type: "text", text: JSON.stringify(results) }], details: { results } };
		},
	});
}

async function runTask(task: Task, ctx: ExtensionToolContext, signal?: AbortSignal): Promise<Result> {
	if (!ctx.model) throw new Error("No model selected for subagent");
	signal?.throwIfAborted();
	const child = await ctx.createChildSession({
		instructions: `You are a subagent. ${ROLE_PROMPTS[task.role]} Do not delegate; return findings to the parent.`,
		readOnly: task.role !== "worker",
	});
	const abort = () => {
		void child.abort();
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) throw signal.reason;
		await child.prompt(task.task);
		const message = child.messages.findLast((item) => item.role === "assistant");
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
		await child.dispose();
	}
}
