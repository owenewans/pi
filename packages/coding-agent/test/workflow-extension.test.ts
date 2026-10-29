import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import workflowExtension from "../src/extensions/workflow/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

async function setup(session = SessionManager.inMemory()) {
	const runtime = createExtensionRuntime();
	runtime.appendEntry = (type, data) => {
		session.appendCustomEntry(type, data);
	};
	const extension = await loadExtensionFromFactory(
		workflowExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"builtin:workflow",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), session, registry);
	const input = vi.fn<(...args: unknown[]) => Promise<string | undefined>>();
	const select = vi.fn<(...args: unknown[]) => Promise<string | undefined>>();
	const setWidget = vi.fn();
	runner.setUIContext({ ...runner.createToolContext("fixture", undefined).ui, input, select, setWidget }, "tui");
	return { session, runner, extension, input, select, setWidget };
}

describe("workflow tools", () => {
	it("stores and restores tasks on session startup", async () => {
		const first = await setup();
		const items = [{ text: "test changes", state: "active" }];
		const todo = first.extension.tools.get("todo")!.definition;
		await todo.execute(
			"tasks",
			{ items },
			undefined,
			undefined,
			first.runner.createToolContext("fixture", undefined),
		);
		expect(first.setWidget).toHaveBeenLastCalledWith("tasks", ["[>] test changes"]);
		const second = await setup(first.session);
		await second.runner.emit({ type: "session_start", reason: "startup" });
		expect(second.setWidget).toHaveBeenLastCalledWith("tasks", ["[>] test changes"]);
		const result = await second.extension.tools
			.get("todo")!
			.definition.execute("show", {}, undefined, undefined, second.runner.createToolContext("fixture", undefined));
		expect(result.content).toEqual([{ type: "text", text: "active: test changes" }]);
	});

	it("clears tasks and the widget with an empty list", async () => {
		const fixture = await setup();
		const todo = fixture.extension.tools.get("todo")!.definition;
		await todo.execute(
			"set",
			{ items: [{ text: "done", state: "done" }] },
			undefined,
			undefined,
			fixture.runner.createToolContext("fixture", undefined),
		);
		await todo.execute(
			"clear",
			{ items: [] },
			undefined,
			undefined,
			fixture.runner.createToolContext("fixture", undefined),
		);
		expect(fixture.setWidget).toHaveBeenLastCalledWith("tasks", undefined);
	});

	it("ignores malformed persisted task entries", async () => {
		const fixture = await setup();
		fixture.session.appendCustomEntry("tasks", [{ text: "broken", state: "other" }]);
		await fixture.runner.emit({ type: "session_start", reason: "startup" });
		expect(fixture.setWidget).toHaveBeenLastCalledWith("tasks", undefined);
	});

	it("collects multiple choices and free-text answers", async () => {
		const fixture = await setup();
		fixture.select.mockResolvedValueOnce("linux");
		fixture.input.mockResolvedValueOnce("example");
		const result = await fixture.extension.tools.get("ask")!.definition.execute(
			"ask",
			{
				questions: [{ question: "OS?", choices: ["linux", "other"] }, { question: "Name?" }],
			},
			undefined,
			undefined,
			fixture.runner.createToolContext("fixture", undefined),
		);
		expect(result.details).toEqual({
			status: "answered",
			answers: [
				{ question: "OS?", answer: "linux" },
				{ question: "Name?", answer: "example" },
			],
		});
	});

	it("allows a custom answer to a choice question", async () => {
		const fixture = await setup();
		fixture.select.mockResolvedValueOnce("Other (write an answer)");
		fixture.input.mockResolvedValueOnce("custom");
		const result = await fixture.extension.tools
			.get("ask")!
			.definition.execute(
				"ask",
				{ questions: [{ question: "Name?", choices: ["preset"] }] },
				undefined,
				undefined,
				fixture.runner.createToolContext("fixture", undefined),
			);
		expect(result.details).toEqual({ status: "answered", answers: [{ question: "Name?", answer: "custom" }] });
	});

	it("stops after cancellation without asking subsequent questions", async () => {
		const fixture = await setup();
		fixture.input.mockResolvedValueOnce(undefined);
		const result = await fixture.extension.tools
			.get("ask")!
			.definition.execute(
				"ask",
				{ questions: [{ question: "First?" }, { question: "Second?" }] },
				undefined,
				undefined,
				fixture.runner.createToolContext("fixture", undefined),
			);
		expect(result.details).toEqual({ status: "cancelled", answers: [] });
		expect(fixture.input).toHaveBeenCalledTimes(1);
	});

	it("does not open a dialog after cancellation of the tool call", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		controller.abort();
		await expect(
			fixture.extension.tools
				.get("ask")!
				.definition.execute(
					"ask",
					{ questions: [{ question: "First?" }] },
					controller.signal,
					undefined,
					fixture.runner.createToolContext("fixture", undefined),
				),
		).rejects.toThrow();
		expect(fixture.input).not.toHaveBeenCalled();
	});

	it("reports that questions require a UI in print mode", async () => {
		const fixture = await setup();
		fixture.runner.setUIContext();
		await expect(
			fixture.extension.tools
				.get("ask")!
				.definition.execute(
					"ask",
					{ questions: [{ question: "First?" }] },
					undefined,
					undefined,
					fixture.runner.createToolContext("fixture", undefined),
				),
		).rejects.toThrow("interactive UI");
	});
});
