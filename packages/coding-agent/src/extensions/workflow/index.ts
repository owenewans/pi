// provides interactive questions and a task list stored on the current session branch.
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

const tasksSchema = Type.Array(
	Type.Object({
		text: Type.String({ minLength: 1 }),
		state: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("done")]),
	}),
);

export default function workflowExtension(pi: ExtensionAPI): void {
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
		for (const entry of ctx.sessionManager.getBranch()) {
			// persisted session data crosses a disk-input boundary.
			if (entry.type === "custom" && entry.customType === "tasks" && Check(tasksSchema, entry.data))
				tasks = entry.data;
		}
		draw(ctx);
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
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
			"Ask the user questions with optional choices and free-text answers. Ask only when a missing fact prevents correct work.",
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
				if (answer === undefined)
					return {
						content: [
							{
								type: "text",
								text: "Questions cancelled. Wait for user input; do not repeat the questions automatically.",
							},
						],
						details: { status: "cancelled", answers },
					};
				answers.push({ question: question.question, answer });
			}
			return {
				content: [{ type: "text", text: JSON.stringify(answers) }],
				details: { status: "answered", answers },
			};
		},
	});
}
