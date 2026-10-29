import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import workflowExtension from "../src/extensions/workflow/index.ts";

const task = "verify the authorized fixture task";

// every blocked request ends on abort or a hard deadline, even if an assertion fails.
function blockedResponse() {
	let started = false;
	let aborted = false;
	let context = "";
	const response: FauxResponseFactory = (request, options) => {
		started = true;
		context = JSON.stringify(request);
		return new Promise((resolve) => {
			const finish = () => {
				aborted = options?.signal?.aborted ?? false;
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", finish);
				resolve(
					fauxAssistantMessage("fixture interrupted", {
						stopReason: aborted ? "aborted" : "error",
						errorMessage: aborted ? "fixture aborted" : "fixture deadline exceeded",
					}),
				);
			};
			const timer = setTimeout(finish, 2000);
			options?.signal?.addEventListener("abort", finish, { once: true });
			if (options?.signal?.aborted) finish();
		});
	};
	return {
		response,
		get started() {
			return started;
		},
		get aborted() {
			return aborted;
		},
		get context() {
			return context;
		},
	};
}

describe("workflow goals with AgentSession", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	async function setup() {
		const dir = mkdtempSync(join(tmpdir(), "pi-goal-session-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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
			extensionFactories: [workflowExtension],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
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
			noTools: "all",
		});
		cleanups.push(async () => {
			await session.abort();
			session.dispose();
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		await session.bindExtensions({});
		const goal = () =>
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "goal")
				.at(-1);
		const waitForSettled = async (count = 1) => {
			await vi.waitFor(() => expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(count), {
				timeout: 3000,
				interval: 5,
			});
			await session.waitForIdle();
		};
		return { session, sessionManager, settingsManager, faux, events, goal, waitForSettled };
	}

	it("continues successful responses, including done, until /stop aborts the request", async () => {
		const { session, faux, events, goal, waitForSettled } = await setup();
		const blocked = blockedResponse();
		faux.setResponses([
			fauxAssistantMessage("first progress"),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("verified more work"),
			blocked.response,
		]);
		await session.prompt(`/goal ${task}`);
		await vi.waitFor(() => expect(blocked.started).toBe(true), {
			timeout: 1500,
			interval: 5,
		});
		expect(faux.state.callCount).toBe(4);
		expect(events.some((event) => event.type === "agent_settled")).toBe(false);
		expect(goal()).toMatchObject({ data: { task, active: true } });
		const hidden = session.messages.filter(
			(message) => message.role === "custom" && message.customType === "goal-continue",
		);
		expect(hidden).toHaveLength(3);
		for (const message of hidden)
			expect(message).toMatchObject({
				display: false,
				content: expect.stringContaining(task),
			});
		expect(blocked.context).toContain("Continue the authorized goal");
		expect(blocked.context).toContain(task);

		await session.prompt("/stop");
		await waitForSettled();
		expect(blocked.aborted).toBe(true);
		expect(goal()).toMatchObject({ data: { task, active: false } });
		expect(events).toContainEqual({ type: "agent_settled", aborted: true });
		faux.appendResponses([fauxAssistantMessage("ordinary response")]);
		await session.prompt("ordinary user prompt");
		await waitForSettled(2);
		expect(faux.state.callCount).toBe(5);
	});

	it.each(["session.abort (Escape)", "/stop"])("pauses on %s and resumes only on explicit request", async (action) => {
		const { session, faux, goal, waitForSettled } = await setup();
		const blocked = blockedResponse();
		faux.setResponses([blocked.response]);
		await session.prompt(`/goal ${task}`);
		await vi.waitFor(() => expect(blocked.started).toBe(true), {
			timeout: 1500,
			interval: 5,
		});
		if (action === "/stop") await session.prompt("/stop");
		else await session.abort();
		await waitForSettled();
		expect(blocked.aborted).toBe(true);
		expect(goal()).toMatchObject({ data: { task, active: false } });
		faux.appendResponses([fauxAssistantMessage("ordinary response")]);
		await session.prompt("do not resume the goal");
		await waitForSettled(2);
		expect(faux.state.callCount).toBe(2);

		const resumed = blockedResponse();
		faux.appendResponses([resumed.response]);
		await session.prompt("/goal resume");
		await vi.waitFor(() => expect(resumed.started).toBe(true), {
			timeout: 1500,
			interval: 5,
		});
		expect(goal()).toMatchObject({ data: { task, active: true } });
		await session.prompt("/stop");
		await waitForSettled(3);
		expect(faux.state.callCount).toBe(3);
	});

	it("does not queue a goal behind existing work or activate it after stopping", async () => {
		const { session, faux, goal, waitForSettled } = await setup();
		const blocked = blockedResponse();
		faux.setResponses([blocked.response]);
		const run = session.prompt("ordinary work");
		await vi.waitFor(() => expect(blocked.started).toBe(true));
		await session.prompt(`/goal ${task}`);
		expect(goal()).toBeUndefined();
		expect(session.getFollowUpMessages()).toEqual([]);
		await session.prompt("/stop");
		await run;
		await waitForSettled();
		faux.appendResponses([fauxAssistantMessage("ordinary response")]);
		await session.prompt("next ordinary prompt");
		expect(faux.state.callCount).toBe(2);
	});

	it("does not activate a goal during manual compaction", async () => {
		const { session, faux, goal } = await setup();
		faux.setResponses([fauxAssistantMessage("initial response")]);
		await session.prompt("initial fixture work");
		const blocked = blockedResponse();
		faux.appendResponses([blocked.response]);
		const compaction = session.compact().catch(() => undefined);
		await vi.waitFor(() => expect(blocked.started).toBe(true));
		await session.prompt(`/goal ${task}`);
		expect(goal()).toBeUndefined();
		await session.prompt("/stop");
		await compaction;
	});

	it("pauses on provider error without retrying or continuing", async () => {
		const { session, faux, events, goal, waitForSettled } = await setup();
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "fixture failure",
			}),
		]);
		await session.prompt(`/goal ${task}`);
		await waitForSettled();
		expect(faux.state.callCount).toBe(1);
		expect(goal()).toMatchObject({ data: { task, active: false } });
		expect(events).toContainEqual({ type: "agent_settled", aborted: false });
		expect(session.messages).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				stopReason: "error",
				errorMessage: "fixture failure",
			}),
		);
		faux.appendResponses([fauxAssistantMessage("ordinary response")]);
		await session.prompt("ordinary user prompt");
		await waitForSettled(2);
		expect(faux.state.callCount).toBe(2);
	});

	it("keeps the goal active through automatic compaction and continues until /stop", async () => {
		const { session, sessionManager, settingsManager, faux, events, goal, waitForSettled } = await setup();
		const blocked = blockedResponse();
		const summary = "The authorized fixture task made progress; continue verification.";
		const goalsDuringCompaction: unknown[] = [];
		settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: faux.getModel().contextWindow - 1, keepRecentTokens: 1 },
		});
		session.subscribe((event) => {
			if (event.type !== "compaction_start" && event.type !== "compaction_end") return;
			const entry = goal();
			goalsDuringCompaction.push(entry?.type === "custom" ? entry.data : undefined);
			if (event.type === "compaction_end") {
				// restore the normal threshold so only the first response triggers compaction.
				settingsManager.applyOverrides({ compaction: { reserveTokens: 16384 } });
			}
		});
		faux.setResponses([
			fauxAssistantMessage("initial goal progress"),
			fauxAssistantMessage(summary),
			fauxAssistantMessage("Goal verification remains in progress."),
			fauxAssistantMessage("done"),
			blocked.response,
		]);
		await session.prompt(`/goal ${task}`);
		await vi.waitFor(() => expect(blocked.started).toBe(true), { timeout: 1500, interval: 5 });

		expect(events.filter((event) => event.type === "compaction_start")).toEqual([
			{ type: "compaction_start", reason: "threshold" },
		]);
		expect(events.filter((event) => event.type === "compaction_end")).toEqual([
			expect.objectContaining({
				reason: "threshold",
				aborted: false,
				willRetry: false,
				result: expect.objectContaining({ summary: expect.stringContaining(summary) }),
			}),
		]);
		expect(goalsDuringCompaction).toEqual([
			{ task, active: true },
			{ task, active: true },
		]);
		expect(sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({ type: "compaction", summary: expect.stringContaining(summary) }),
		);
		expect(goal()).toMatchObject({ data: { task, active: true } });
		expect(events.some((event) => event.type === "agent_settled")).toBe(false);
		expect(faux.state.callCount).toBe(5);
		expect(blocked.context).toContain(summary);
		expect(blocked.context).toContain("Continue the authorized goal");
		expect(blocked.context).toContain(task);
		expect(blocked.context).toContain("done");

		await session.prompt("/stop");
		await waitForSettled();
		expect(blocked.aborted).toBe(true);
		expect(goal()).toMatchObject({ data: { task, active: false } });
		expect(events).toContainEqual({ type: "agent_settled", aborted: true });
		expect(faux.state.callCount).toBe(5);
	});

	it("retains the paused goal through real compaction and restores context on resume", async () => {
		const { session, sessionManager, faux, goal, waitForSettled } = await setup();
		faux.setResponses([
			fauxAssistantMessage("progress"),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "pause fixture",
			}),
		]);
		await session.prompt("initial fixture work");
		await session.prompt(`/goal ${task}`);
		await waitForSettled(2);
		faux.appendResponses([fauxAssistantMessage("The authorized fixture task made progress and is paused.")]);
		const result = await session.compact();
		expect(result.summary).toContain("authorized fixture task");
		expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		expect(goal()).toMatchObject({ data: { task, active: false } });
		const resumed = blockedResponse();
		faux.appendResponses([resumed.response]);
		await session.prompt("/goal resume");
		await vi.waitFor(() => expect(resumed.started).toBe(true), {
			timeout: 1500,
			interval: 5,
		});
		expect(resumed.context).toContain(`Active goal: ${task}`);
		expect(goal()).toMatchObject({ data: { task, active: true } });
		await session.prompt("/stop");
		await waitForSettled(3);
		expect(faux.state.callCount).toBe(4);
	});
});
