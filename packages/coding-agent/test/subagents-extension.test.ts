import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import subagentsExtension from "../src/extensions/subagents/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

type JobInfo = {
	id: string;
	role: "scout" | "reviewer" | "worker";
	task: string;
	status: "running" | "completed" | "failed" | "stopped";
	output?: string;
};

let directory: string;
const runners: ExtensionRunner[] = [];
const releases: (() => void)[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-subagents-extension-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const runner of runners.splice(0)) await runner.emit({ type: "session_shutdown", reason: "quit" });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function blockedResponse(text = "finished") {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 3000);
		release = () => {
			clearTimeout(timer);
			resolve();
		};
	});
	releases.push(release);
	let signal: AbortSignal | undefined;
	const response: FauxResponseFactory = async (_context, options) => {
		signal = options?.signal;
		await ready;
		return fauxAssistantMessage(text);
	};
	return {
		response,
		release,
		get signal() {
			return signal;
		},
	};
}

async function setup(responses: FauxResponseStep[] = []) {
	const runtime = createExtensionRuntime();
	const sendMessage = vi.fn();
	runtime.sendMessage = sendMessage;
	runtime.getThinkingLevel = () => "off";
	const extension = await loadExtensionFromFactory(
		subagentsExtension,
		directory,
		createEventBus(),
		runtime,
		"builtin:subagents",
	);
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const faux = fauxProvider();
	faux.setResponses(responses);
	registry.registerProvider(faux.provider);
	const runner = new ExtensionRunner([extension], runtime, directory, SessionManager.inMemory(directory), registry);
	runners.push(runner);
	const registered = extension.tools.get("subagent");
	if (!registered) throw new Error("subagent tool not registered");
	const tool = registered.definition;
	const context = runner.createToolContext("fixture", undefined);
	Object.defineProperty(context, "model", {
		value: faux.getModel(),
		configurable: true,
	});
	context.getSystemPrompt = () => "parent system prompt";
	async function execute(params: Parameters<typeof tool.execute>[1], signal?: AbortSignal) {
		const result = await tool.execute("fixture", params, signal, undefined, context);
		const { results } = result.details as { results: JobInfo[] };
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: JSON.stringify(results),
		});
		return results;
	}
	return { runner, tool, context, registry, faux, sendMessage, execute };
}

async function settle(runner: ExtensionRunner, outcome: "completed" | "aborted" | "error" = "completed") {
	return runner.emitBoundary({ type: "agent_before_settle", outcome }, () => ({
		contextEntries: [],
		contextMessages: [],
		llmMessages: [],
		pendingMessages: [],
		canContinue: false,
	}));
}

const task = (role: "scout" | "reviewer" | "worker" = "scout", text = "investigate fixture") => ({ role, task: text });

describe("subagent tool", () => {
	it("uses optional tasks so management actions need no dummy tasks", async () => {
		const fixture = await setup();
		expect(fixture.tool.parameters).toMatchObject({
			type: "object",
			properties: { tasks: { minItems: 1, maxItems: 4 } },
		});
		expect((fixture.tool.parameters as { required?: string[] }).required ?? []).not.toContain("tasks");
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		expect(await fixture.execute({ action: "clear" })).toEqual([]);
	});

	it("returns IDs before completion, allows parent work and survives parent abort", async () => {
		const blocked = blockedResponse();
		const fixture = await setup([blocked.response, fauxAssistantMessage("parent worked")]);
		const parentController = new AbortController();
		const [job] = await fixture.execute({ tasks: [task()] }, parentController.signal);
		expect(job).toMatchObject({
			id: expect.any(String),
			status: "running",
			role: "scout",
		});
		await vi.waitFor(() => expect(blocked.signal).toBeDefined());
		parentController.abort();
		expect(blocked.signal?.aborted).toBe(false);
		const parent = new Agent({
			initialState: {
				model: fixture.faux.getModel(),
				systemPrompt: "parent",
				tools: [],
			},
			streamFn: (model, context, options) => fixture.registry.streamSimple(model, context, options),
		});
		await parent.prompt("do independent work");
		expect(parent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "parent worked" }],
		});
		expect(await fixture.execute({ action: "result", id: job.id })).toEqual([job]);
		expect(fixture.sendMessage).not.toHaveBeenCalled();
		blocked.release();
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		const [result] = await fixture.execute({ action: "result", id: job.id });
		expect(result).toEqual({ ...job, status: "completed", output: "finished" });
		expect(fixture.sendMessage).toHaveBeenCalledWith(
			{
				customType: "subagent-result",
				content: JSON.stringify(result),
				display: true,
				details: result,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(await fixture.execute({ action: "list" })).toEqual([{ ...job, status: "completed" }]);
		expect(await fixture.execute({ action: "clear" })).toEqual([]);
		await expect(fixture.execute({ action: "result", id: job.id })).rejects.toThrow("Unknown subagent");
	});

	it("persists busy completions and requests one hidden continuation at normal settlement", async () => {
		const blocked = [blockedResponse("first"), blockedResponse("second")];
		const fixture = await setup(blocked.map((item) => item.response));
		fixture.context.isIdle = () => false;
		const jobs = await fixture.execute({ tasks: [task(), task("worker")] });
		for (const item of blocked) item.release();
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(2));
		for (const [index, job] of jobs.entries()) {
			const result = {
				...job,
				status: "completed",
				output: index === 0 ? "first" : "second",
			};
			expect(fixture.sendMessage).toHaveBeenCalledWith(
				{
					customType: "subagent-result",
					content: JSON.stringify(result),
					display: true,
					details: result,
				},
				{ triggerTurn: false, deliverAs: "followUp" },
			);
		}
		expect(await settle(fixture.runner)).toMatchObject({
			continue: true,
			entries: [
				{
					type: "custom_message",
					customType: "subagent-continue",
					display: false,
					content: "Review the completed subagent results and continue the authorized task.",
				},
			],
		});
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
		expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
	});

	it.each(["aborted", "error"] as const)("does not wake a parent settling with %s", async (outcome) => {
		const fixture = await setup([fauxAssistantMessage("finished")]);
		fixture.context.isIdle = () => false;
		await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await settle(fixture.runner, outcome)).toMatchObject({
			continue: false,
			entries: [],
		});
		await fixture.runner.emit({
			type: "agent_settled",
			aborted: outcome === "aborted",
		});
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
	});

	it("clears a pending wake when the parent settles after an explicit interrupt", async () => {
		const fixture = await setup([fauxAssistantMessage("finished")]);
		fixture.context.isIdle = () => false;
		await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		await fixture.runner.emit({ type: "agent_settled", aborted: true });
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
	});

	it("wakes on results arriving between the last boundary and normal settlement", async () => {
		const fixture = await setup([fauxAssistantMessage("late result")]);
		fixture.context.isIdle = () => false;
		await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		await fixture.runner.emit({ type: "agent_settled", aborted: false });
		expect(fixture.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ customType: "subagent-continue", display: false }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await fixture.runner.emit({ type: "agent_settled", aborted: false });
		expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
	});

	it("clears completed jobs and their pending continuation on branch navigation", async () => {
		const fixture = await setup([fauxAssistantMessage("old result")]);
		fixture.context.isIdle = () => false;
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		await fixture.runner.emit({
			type: "session_tree",
			oldLeafId: "old",
			newLeafId: "new",
		});
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		await expect(fixture.execute({ action: "result", id: job.id })).rejects.toThrow("Unknown subagent");
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
		expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("cancels all old jobs on branch navigation and allows a fresh generation", async () => {
		const blocked = [blockedResponse("old scout"), blockedResponse("old worker")];
		const fixture = await setup([...blocked.map((item) => item.response), fauxAssistantMessage("new branch")]);
		const jobs = await fixture.execute({ tasks: [task(), task("worker")] });
		await vi.waitFor(() => expect(blocked.every((item) => item.signal !== undefined)).toBe(true));
		let settled = false;
		const navigation = fixture.runner.emit({ type: "session_tree", oldLeafId: "old", newLeafId: "new" }).then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(blocked.every((item) => item.signal?.aborted)).toBe(true));
		expect(settled).toBe(false);
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		for (const job of jobs) {
			await expect(fixture.execute({ action: "result", id: job.id })).rejects.toThrow("Unknown subagent");
		}
		blocked[0].release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		blocked[1].release();
		await navigation;
		expect(fixture.sendMessage).not.toHaveBeenCalled();
		expect(await settle(fixture.runner)).toMatchObject({
			continue: false,
			entries: [],
		});
		const [fresh] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "list" })).toEqual([{ ...fresh, status: "completed" }]);
		expect(await fixture.execute({ action: "result", id: fresh.id })).toMatchObject([{ output: "new branch" }]);
	});

	it.each(["scout", "reviewer", "worker"] as const)(
		"gives %s its role tools and isolated task context",
		async (role) => {
			const fixture = await setup([
				(context) => {
					const system = context.messages.find((message) => message.role === "system");
					expect(JSON.stringify(system)).toContain("parent system prompt");
					expect(JSON.stringify(system)).toContain("Do not delegate");
					expect(JSON.stringify(system)).toContain(
						role === "worker"
							? "Implement the assigned task"
							: role === "scout"
								? "Investigate the assigned task"
								: "Review the assigned change",
					);
					expect(system?.toolsAdded?.map((tool) => tool.name).sort()).toEqual(
						role === "worker" ? ["bash", "edit", "read", "write"] : ["find", "grep", "ls", "read"],
					);
					expect(context.messages.filter((message) => message.role !== "system")).toMatchObject([
						{
							role: "user",
							content: [{ type: "text", text: "self-contained task" }],
						},
					]);
					return fauxAssistantMessage("role checked");
				},
			]);
			const [job] = await fixture.execute({
				tasks: [task(role, "self-contained task")],
			});
			await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
			expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([
				{ status: "completed", output: "role checked" },
			]);
		},
	);

	it("enforces four active jobs across calls and clears only finished jobs", async () => {
		const blocked = Array.from({ length: 5 }, () => blockedResponse());
		const fixture = await setup(blocked.map((item) => item.response));
		const first = await fixture.execute({ tasks: [task(), task("reviewer")] });
		const second = await fixture.execute({
			action: "start",
			tasks: [task("worker"), task()],
		});
		expect(new Set([...first, ...second].map((job) => job.id)).size).toBe(4);
		await expect(fixture.execute({ tasks: [task()] })).rejects.toThrow("At most four");
		expect(await fixture.execute({ action: "clear" })).toHaveLength(4);
		blocked[0].release();
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		expect(await fixture.execute({ action: "clear" })).toHaveLength(3);
		expect(await fixture.execute({ tasks: [task()] })).toHaveLength(1);
		expect(await fixture.execute({ action: "list" })).toHaveLength(4);
	});

	it("stops a job, waits for it and never delivers a stopped notification", async () => {
		const blocked = blockedResponse();
		const fixture = await setup([blocked.response]);
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(blocked.signal).toBeDefined());
		let settled = false;
		const stopping = fixture.execute({ action: "stop", id: job.id }).then((result) => {
			settled = true;
			return result;
		});
		await vi.waitFor(() => expect(blocked.signal?.aborted).toBe(true));
		expect(settled).toBe(false);
		blocked.release();
		expect(await stopping).toMatchObject([{ id: job.id, status: "stopped" }]);
		expect(await fixture.execute({ action: "stop", id: job.id })).toMatchObject([{ status: "stopped" }]);
		expect(await fixture.execute({ action: "result", id: job.id })).toMatchObject([{ status: "stopped" }]);
		expect(fixture.sendMessage).not.toHaveBeenCalled();
	});

	it("delivers thrown provider failures as failed results and wakes the parent", async () => {
		const fixture = await setup([
			() => {
				throw new Error("offline provider exploded");
			},
		]);
		const [job] = await fixture.execute({ tasks: [task()] });
		await vi.waitFor(() => expect(fixture.sendMessage).toHaveBeenCalledTimes(1));
		const [result] = await fixture.execute({ action: "result", id: job.id });
		expect(result).toMatchObject({
			status: "failed",
			output: expect.stringContaining("offline provider exploded"),
		});
		expect(fixture.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-result",
				details: result,
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it("aborts all jobs on shutdown and waits without delivering results", async () => {
		const blocked = [blockedResponse(), blockedResponse()];
		const fixture = await setup(blocked.map((item) => item.response));
		await fixture.execute({ tasks: [task(), task("worker")] });
		await vi.waitFor(() => expect(blocked.every((item) => item.signal !== undefined)).toBe(true));
		let settled = false;
		const shutdown = fixture.runner.emit({ type: "session_shutdown", reason: "quit" }).then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(blocked.every((item) => item.signal?.aborted)).toBe(true));
		expect(settled).toBe(false);
		blocked[0].release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		blocked[1].release();
		await shutdown;
		expect(fixture.sendMessage).not.toHaveBeenCalled();
		await expect(fixture.execute({ tasks: [task()] })).rejects.toThrow("shut down");
	});

	it("rejects an already aborted start without creating a job", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		controller.abort(new Error("parent interrupted"));
		await expect(fixture.execute({ tasks: [task()] }, controller.signal)).rejects.toThrow("parent interrupted");
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		expect(fixture.faux.state.callCount).toBe(0);
	});

	it("requires a model only for starting jobs", async () => {
		const fixture = await setup();
		Object.defineProperty(fixture.context, "model", { value: undefined });
		await expect(fixture.execute({ tasks: [task()] })).rejects.toThrow("No model selected");
		expect(await fixture.execute({ action: "list" })).toEqual([]);
		expect(await fixture.execute({ action: "clear" })).toEqual([]);
	});

	it.each([
		[{}, "start requires tasks"],
		[{ action: "start", tasks: [] }, "start requires tasks"],
		[{ action: "result" }, "result requires id"],
		[{ action: "stop" }, "stop requires id"],
		[{ action: "result", id: "missing" }, "Unknown subagent"],
		[{ action: "stop", id: "missing" }, "Unknown subagent"],
	] as const)("rejects invalid action arguments: %j", async (params, error) => {
		const fixture = await setup();
		await expect(
			fixture.execute({
				...params,
				...("tasks" in params ? { tasks: [] } : {}),
			}),
		).rejects.toThrow(error);
	});
});
