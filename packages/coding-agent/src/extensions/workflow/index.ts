// provides questions, tasks and continuous goals on the current session branch.
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

const tasksSchema = Type.Array(
	Type.Object({
		text: Type.String({ minLength: 1 }),
		state: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("done")]),
	}),
);

const goalSchema = Type.Object({ task: Type.String({ minLength: 1 }), active: Type.Boolean() });

export default function workflowExtension(pi: ExtensionAPI): void {
	let goal = { task: "", active: false };
	const saveGoal = (ctx: ExtensionContext) => {
		pi.appendEntry("goal", { ...goal });
		ctx.ui.setStatus("goal", goal.active ? "goal" : undefined);
	};
	const pauseGoal = (ctx: ExtensionContext) => {
		if (!goal.active) return;
		goal.active = false;
		saveGoal(ctx);
	};
	let tasks: { text: string; state: "pending" | "active" | "done" }[] = [];
	const draw = (ctx: ExtensionContext) => {
		ctx.ui.setWidget(
			"tasks",
			tasks.length
				? tasks.map((task) => {
						let marker = " ";
						if (task.state === "active") marker = ">";
						else if (task.state === "done") marker = "x";
						return `[${marker}] ${task.text}`;
					})
				: undefined,
		);
	};
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		tasks = [];
		goal = { task: "", active: false };
		for (const entry of ctx.sessionManager.getBranch()) {
			// persisted session data crosses a disk-input boundary.
			if (entry.type === "custom" && entry.customType === "tasks" && Check(tasksSchema, entry.data))
				tasks = entry.data;
			if (entry.type === "custom" && entry.customType === "goal" && Check(goalSchema, entry.data))
				goal = { ...entry.data };
		}
		// reopening a session or branch retains the task without starting requests.
		pauseGoal(ctx);
		ctx.ui.setStatus("goal", undefined);
		draw(ctx);
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("before_agent_start", () => {
		if (!goal.active) return;
		return {
			message: {
				customType: "goal-context",
				content: `Active goal: ${goal.task}\nKeep working on this authorized goal until the user sends /stop. Verify results and pursue remaining work within its scope. Do not invent unrelated tasks or repeat completed actions. Ask when missing input prevents correct work.`,
				display: false,
			},
		};
	});
	pi.on("agent_before_settle", (event, ctx) => {
		if (!goal.active) return;
		if (event.outcome !== "completed") {
			pauseGoal(ctx);
			return;
		}
		if (event.continue || ctx.hasPendingMessages()) return;
		return {
			continue: true,
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "goal-continue",
					content: `Continue the authorized goal: ${goal.task}\nCheck progress and do the next useful work within scope. The goal remains active until /stop; do not expand its scope or repeat completed actions.`,
					display: false,
				},
			],
		};
	});
	pi.on("agent_settled", (_event, ctx) => pauseGoal(ctx));
	pi.registerCommand("goal", {
		description: "Work continuously: /goal <task>, /goal resume; /stop to stop",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify(
					goal.task ? `${goal.active ? "active" : "paused"}: ${goal.task}` : "use /goal <task>",
					"info",
				);
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("wait for current work to finish, or /stop before starting a goal", "error");
				return;
			}
			if (task === "resume") {
				if (!goal.task) {
					ctx.ui.notify("no goal to resume", "error");
					return;
				}
			} else goal.task = task;
			goal.active = true;
			saveGoal(ctx);
			pi.sendUserMessage(goal.task, { deliverAs: "followUp" });
		},
	});
	pi.registerCommand("stop", {
		description: "Stop the goal and abort current work",
		handler: async (_args, ctx) => {
			pauseGoal(ctx);
			ctx.abort();
		},
	});
	pi.registerTool({
		name: "todo",
		label: "Tasks",
		description: "Replace or display the task list. Tasks persist on the current session branch.",
		parameters: Type.Object({ items: Type.Optional(tasksSchema) }),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.items) {
				tasks = params.items;
				pi.appendEntry("tasks", tasks);
			}
			draw(ctx);
			return {
				content: [
					{ type: "text", text: tasks.map((task) => `${task.state}: ${task.text}`).join("\n") || "no tasks" },
				],
				details: { items: tasks },
			};
		},
	});
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user clarification questions, including short questions, instead of asking in chat. Provide selectable choices when applicable. Ask only when a missing fact prevents correct work.",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({ question: Type.String({ minLength: 1 }), choices: Type.Optional(Type.Array(Type.String())) }),
				{ minItems: 1 },
			),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!ctx.hasUI) throw new Error("ask requires an interactive UI");
			const answers: { question: string; answer: string }[] = [];
			for (const question of params.questions) {
				signal?.throwIfAborted();
				let answer: string | undefined;
				if (question.choices?.length) {
					const custom = "Other (write an answer)";
					answer = await ctx.ui.select(question.question, [...question.choices, custom]);
					if (answer === custom) answer = await ctx.ui.input(question.question);
				} else answer = await ctx.ui.input(question.question);
				signal?.throwIfAborted();
				if (answer === undefined) {
					pauseGoal(ctx);
					return {
						content: [
							{
								type: "text",
								text: "Questions cancelled. Wait for user input; do not repeat the questions automatically.",
							},
						],
						details: { status: "cancelled", answers },
					};
				}
				answers.push({ question: question.question, answer });
			}
			return {
				content: [{ type: "text", text: JSON.stringify(answers) }],
				details: { status: "answered", answers },
			};
		},
	});
}
