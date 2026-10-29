import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import subagentsExtension from "../src/extensions/subagents/index.ts";

const childTask = "investigate the isolated fixture";
const childOutput = "child fixture finding: verified 7319";
const parentOutput = "independent parent work completed";
const waitOptions = { timeout: 3000, interval: 5 };

// blocked requests always finish on release, abort, or deadline.
function blockedResponse(text: string) {
	let started = false;
	let released = false;
	let expired = false;
	let finish: (() => void) | undefined;
	const response: FauxResponseFactory = (_context, options) => {
		started = true;
		return new Promise((resolve) => {
			finish = () => {
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", finishRequest);
				resolve(
					fauxAssistantMessage(text, {
						stopReason: options?.signal?.aborted ? "aborted" : expired ? "error" : "stop",
						...(expired ? { errorMessage: "fixture deadline exceeded" } : {}),
					}),
				);
			};
			const finishRequest = () => finish?.();
			const timer = setTimeout(() => {
				expired = true;
				finishRequest();
			}, 5000);
			options?.signal?.addEventListener("abort", finishRequest, { once: true });
			if (released || options?.signal?.aborted) finishRequest();
		});
	};
	return {
		response,
		release() {
			released = true;
			finish?.();
		},
		get started() {
			return started;
		},
		get expired() {
			return expired;
		},
	};
}

describe("background subagents with AgentSession", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function setup() {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-session-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const model = faux.getModel();
		const auth = AuthStorage.inMemory();
		await auth.modify(model.provider, async () => ({
			type: "api_key",
			key: "fixture-key",
		}));
		const modelRuntime = await ModelRuntime.create({
			credentials: auth,
			modelsPath: join(dir, "models.json"),
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});
		const settingsManager = SettingsManager.create(dir, dir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager,
			extensionFactories: [subagentsExtension],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		settingsManager.applyOverrides({
			retry: { enabled: false },
			compaction: { enabled: false, keepRecentTokens: 1 },
			cacheWarming: "off",
		});
		const sessionManager = SessionManager.inMemory(dir);
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["subagent"],
		});
		cleanups.push(async () => {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			await session.abort();
			session.dispose();
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		await session.bindExtensions({});
		expect(session.getActiveToolNames()).toContain("subagent");
		return { session, sessionManager, faux, events };
	}

	it.each(["idle", "busy"] as const)("delivers one automatic follow-up when the parent is %s", async (state) => {
		const { session, sessionManager, faux, events } = await setup();
		const child = blockedResponse(childOutput);
		const parent = blockedResponse(parentOutput);
		cleanups.push(() => {
			child.release();
			parent.release();
		});
		const delivery = vi.spyOn(session, "sendCustomMessage");
		const followUp = vi.fn<FauxResponseFactory>((context) => {
			const transcript = JSON.stringify(context);
			expect(transcript.split(childOutput)).toHaveLength(2);
			expect(transcript).toContain(parentOutput);
			expect(context.messages.at(-1)).toMatchObject({
				role: "user",
				content: expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining(
							state === "idle" ? childOutput : "Review the completed subagent results",
						),
					}),
				]),
			});
			return fauxAssistantMessage("parent incorporated the child finding");
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", { tasks: [{ role: "scout", task: childTask }] }, { id: "start-child" }),
				{ stopReason: "toolUse" },
			),
			child.response,
			state === "busy" ? parent.response : fauxAssistantMessage(parentOutput),
			followUp,
		]);
		const run = session.prompt("Delegate the fixture investigation and do independent parent work.");
		await vi.waitFor(() => expect(child.started).toBe(true), waitOptions);
		const toolResult = session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({
			role: "toolResult",
			toolName: "subagent",
			isError: false,
		});
		if (toolResult?.role !== "toolResult") throw new Error("missing subagent tool result");
		const [job] = JSON.parse(
			toolResult.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		);
		expect(job).toEqual({
			id: expect.any(String),
			role: "scout",
			task: childTask,
			status: "running",
		});
		await vi.waitFor(() => expect(faux.state.callCount).toBe(3), waitOptions);
		expect(delivery).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();

		if (state === "idle") {
			await run;
			await session.waitForIdle();
			expect(session.isIdle).toBe(true);
			expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: parentOutput }],
			});
		} else {
			expect(parent.started).toBe(true);
			expect(session.isStreaming).toBe(true);
		}

		child.release();
		await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1), waitOptions);
		const result = { ...job, status: "completed", output: childOutput };
		expect(delivery).toHaveBeenCalledWith(
			{
				customType: "subagent-result",
				content: JSON.stringify(result),
				display: true,
				details: result,
			},
			{ triggerTurn: state === "idle", deliverAs: "followUp" },
		);
		if (state === "busy") {
			expect(followUp).not.toHaveBeenCalled();
			expect(faux.state.callCount).toBe(3);
			expect(session.messages.some((message) => message.role === "custom")).toBe(false);
			expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(0);
			parent.release();
		}
		await run;
		await vi.waitFor(() => expect(followUp).toHaveBeenCalledTimes(1), waitOptions);
		await session.waitForIdle();
		expect(child.expired).toBe(false);
		expect(parent.expired).toBe(false);
		expect(faux.state.callCount).toBe(4);
		expect(faux.getPendingResponseCount()).toBe(0);
		const continuations = session.messages.filter(
			(message) => message.role === "custom" && message.customType === "subagent-continue",
		);
		expect(continuations).toEqual(state === "idle" ? [] : [expect.objectContaining({ display: false })]);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.getFollowUpMessages()).toEqual([]);
		expect(delivery).toHaveBeenCalledTimes(1);
		expect(
			session.messages.filter((message) => message.role === "custom" && message.customType === "subagent-result"),
		).toEqual([
			expect.objectContaining({
				content: JSON.stringify(result),
				details: result,
			}),
		]);
		expect(
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-result"),
		).toHaveLength(1);
		expect(
			events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === "subagent-result",
			),
		).toHaveLength(1);
		expect(events.filter((event) => event.type === "turn_start")).toHaveLength(3);
		expect(events.filter((event) => event.type === "agent_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(state === "idle" ? 2 : 1);
		expect(session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "parent incorporated the child finding" }],
		});
	});
	it("retains one busy child result across parent abort and queue clearing without restarting", async () => {
		const { session, sessionManager, faux, events } = await setup();
		const child = blockedResponse(childOutput);
		const parent = blockedResponse(parentOutput);
		cleanups.push(() => {
			child.release();
			parent.release();
		});
		const delivery = vi.spyOn(session, "sendCustomMessage");
		const ordinary = vi.fn<FauxResponseFactory>((context) => {
			expect(JSON.stringify(context).split(childOutput)).toHaveLength(2);
			expect(context.messages.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "text", text: "Continue ordinary work." }],
			});
			return fauxAssistantMessage("ordinary work resumed");
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", {
					tasks: [{ role: "scout", task: childTask }],
				}),
				{ stopReason: "toolUse" },
			),
			child.response,
			parent.response,
			ordinary,
		]);
		const run = session.prompt("Delegate and continue working.");
		await vi.waitFor(() => expect(parent.started).toBe(true), waitOptions);
		child.release();
		await vi.waitFor(() => expect(delivery).toHaveBeenCalledTimes(1), waitOptions);
		expect(delivery).toHaveBeenCalledWith(expect.objectContaining({ customType: "subagent-result" }), {
			triggerTurn: false,
			deliverAs: "followUp",
		});
		const abort = session.abort();
		expect(session.clearQueue()).toEqual({ steering: [], followUp: [] });
		await abort;
		await run;
		await session.waitForIdle();
		expect(session.isIdle).toBe(true);
		expect(faux.state.callCount).toBe(3);
		expect(ordinary).not.toHaveBeenCalled();
		expect(session.pendingMessageCount).toBe(0);
		expect(session.getFollowUpMessages()).toEqual([]);
		const results = () =>
			session.messages.filter((message) => message.role === "custom" && message.customType === "subagent-result");
		expect(results()).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					status: "completed",
					output: childOutput,
				}),
			}),
		]);
		expect(
			session.messages.filter((message) => message.role === "custom" && message.customType === "subagent-continue"),
		).toEqual([]);
		expect(events.filter((event) => event.type === "agent_settled")).toEqual([
			{ type: "agent_settled", aborted: true },
		]);

		await session.prompt("Continue ordinary work.");
		await session.waitForIdle();
		expect(ordinary).toHaveBeenCalledTimes(1);
		expect(faux.state.callCount).toBe(4);
		expect(delivery).toHaveBeenCalledTimes(1);
		expect(results()).toHaveLength(1);
		expect(
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-result"),
		).toHaveLength(1);
		expect(
			events.filter(
				(event) =>
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === "subagent-result",
			),
		).toHaveLength(1);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.getFollowUpMessages()).toEqual([]);
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(child.expired || parent.expired).toBe(false);
	});

	it("cancels background jobs and clears their results when navigating a real session branch", async () => {
		const { session, sessionManager, faux } = await setup();
		const children = [blockedResponse("discard scout"), blockedResponse("discard worker")];
		cleanups.push(() => {
			for (const child of children) child.release();
		});
		const delivery = vi.spyOn(session, "sendCustomMessage");
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", {
					tasks: [
						{ role: "scout", task: childTask },
						{ role: "worker", task: "independent worker fixture" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			...children.map((child) => child.response),
			fauxAssistantMessage(parentOutput),
			fauxAssistantMessage(fauxToolCall("subagent", { action: "list" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				expect(result).toMatchObject({
					role: "toolResult",
					toolName: "subagent",
					content: [{ type: "text", text: "[]" }],
				});
				return fauxAssistantMessage("new branch has no old jobs");
			},
		]);
		await session.prompt("Delegate two independent tasks and finish parent work.");
		await session.waitForIdle();
		expect(children.every((child) => child.started)).toBe(true);
		const target = sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!target) throw new Error("missing branch target");
		expect(await session.navigateTree(target.id)).toMatchObject({
			cancelled: false,
		});
		for (const child of children) child.release();
		await session.prompt("List jobs on this branch.");
		await session.waitForIdle();
		expect(delivery).not.toHaveBeenCalled();
		expect(
			session.messages.filter((message) => message.role === "custom" && message.customType.startsWith("subagent-")),
		).toEqual([]);
		expect(
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType.startsWith("subagent-")),
		).toEqual([]);
		expect(session.pendingMessageCount).toBe(0);
		expect(faux.state.callCount).toBe(6);
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(children.some((child) => child.expired)).toBe(false);
	});
});
