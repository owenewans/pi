import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import codexSearchExtension from "../src/extensions/codex-search/index.ts";
import { collectSearchEvidence } from "../src/extensions/codex-search/sources.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const search = {
	type: "web_search_call",
	id: "ws_1",
	status: "completed",
	action: {
		type: "search",
		query: "fixture query",
		sources: [{ type: "url", url: "https://example.org/source", title: "source" }],
	},
};
const message = {
	type: "message",
	content: [
		{
			type: "output_text",
			text: "verified",
			annotations: [
				{
					type: "url_citation",
					url: "https://example.org/source",
					title: "cited source",
					start_index: 0,
					end_index: 8,
				},
			],
		},
	],
};

afterEach(() => vi.restoreAllMocks());

async function setup(oauth = true) {
	const auth = AuthStorage.inMemory();
	if (oauth)
		await auth.modify("openai-codex", async () => ({
			type: "oauth",
			access: "fixture-token",
			refresh: "fixture-refresh",
			expires: Date.now() + 3600000,
		}));
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		codexSearchExtension,
		process.cwd(),
		createEventBus(),
		runtime,
		"builtin:codex-search",
	);
	const registry = await createInMemoryModelRegistry(auth);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), registry);
	const tool = extension.tools.get("codex_search")!.definition;
	const ctx = runner.createToolContext("fixture", undefined);
	const result = fauxAssistantMessage("Verified [source](https://example.org/source)");
	let observed: unknown[] = [search, message];
	const stream = vi.spyOn(registry, "stream").mockImplementation((_model, _context, options) => {
		const events = createAssistantMessageEventStream();
		void (async () => {
			for (const item of observed)
				await options?.onProviderStreamEvent?.({ type: "response.output_item.done", item }, _model);
			events.push({ type: "done", reason: "stop", message: result });
			events.end();
		})();
		return events;
	});
	return {
		tool,
		ctx,
		registry,
		stream,
		result,
		setObserved(items: unknown[]) {
			observed = items;
		},
	};
}

describe("Codex hosted search tool", () => {
	it.each(["live", "cached"] as const)("uses the native authenticated transport with mode=%s", async (mode) => {
		const fixture = await setup();
		const result = await fixture.tool.execute(
			"search",
			{ query: " fixture query ", mode },
			undefined,
			undefined,
			fixture.ctx,
		);
		expect(fixture.stream).toHaveBeenCalledTimes(1);
		const [model, context, options] = fixture.stream.mock.calls[0];
		expect(model.provider).toBe("openai-codex");
		expect(context.tools).toBeUndefined();
		expect(context.messages).toHaveLength(1);
		expect(JSON.stringify(context)).not.toContain("fixture-token");
		expect(options).toMatchObject({
			webSearch: mode,
			transport: "sse",
			toolChoice: "required",
			maxRetries: 0,
			signal: expect.any(AbortSignal),
		});
		const text = result.content[0];
		if (text.type !== "text") throw Error("missing text");
		expect(JSON.parse(text.text)).toMatchObject({
			untrusted: true,
			mode,
			query: "fixture query",
			sources: [{ url: "https://example.org/source", title: "cited source", cited: true }],
			actions: [{ type: "search", query: "fixture query" }],
		});
	});

	it("uses the current Codex model, not a different model", async () => {
		const fixture = await setup();
		const current = fixture.registry
			.getAll()
			.find((model) => model.provider === "openai-codex" && model.id !== "gpt-6.1-sol")!;
		expect(current).toBeDefined();
		Object.defineProperty(fixture.ctx, "model", { value: current });
		await fixture.tool.execute("search", { query: "fixture" }, undefined, undefined, fixture.ctx);
		expect(fixture.stream.mock.calls[0][0]).toBe(current);
	});

	it("requires an existing ChatGPT OAuth login", async () => {
		const fixture = await setup(false);
		await expect(
			fixture.tool.execute("search", { query: "fixture" }, undefined, undefined, fixture.ctx),
		).rejects.toThrow("/login openai-codex");
		expect(fixture.stream).not.toHaveBeenCalled();
	});

	it("does not fall back for an unknown selected model", async () => {
		const fixture = await setup();
		await expect(
			fixture.tool.execute("search", { query: "fixture", model: "missing" }, undefined, undefined, fixture.ctx),
		).rejects.toThrow("No matching Codex model");
		expect(fixture.stream).not.toHaveBeenCalled();
	});

	it("rejects a model answer without completed search evidence", async () => {
		const fixture = await setup();
		fixture.setObserved([message]);
		await expect(
			fixture.tool.execute("search", { query: "fixture" }, undefined, undefined, fixture.ctx),
		).rejects.toThrow("no completed web search");
	});

	it("reports provider errors without switching engines or models", async () => {
		const fixture = await setup();
		fixture.result.stopReason = "error";
		fixture.result.errorMessage = "fixture quota exceeded";
		await expect(
			fixture.tool.execute("search", { query: "fixture" }, undefined, undefined, fixture.ctx),
		).rejects.toThrow("fixture quota exceeded");
		expect(fixture.stream).toHaveBeenCalledTimes(1);
	});

	it("honors an already aborted tool call", async () => {
		const fixture = await setup();
		const controller = new AbortController();
		controller.abort(Error("cancelled"));
		await expect(
			fixture.tool.execute("search", { query: "fixture" }, controller.signal, undefined, fixture.ctx),
		).rejects.toThrow("cancelled");
		expect(fixture.stream).not.toHaveBeenCalled();
	});
});

describe("Codex search evidence", () => {
	it("collects citations and completed search actions from terminal output without duplicate sources", () => {
		const evidence = collectSearchEvidence();
		evidence.observe({
			type: "response.output_text.annotation.added",
			annotation: message.content[0].annotations[0],
		});
		evidence.observe({ type: "response.completed", response: { output: [search, message] } });
		evidence.observe({ type: "response.completed", response: { output: [search, message] } });
		expect(evidence.searched()).toBe(true);
		expect(evidence.sources()).toEqual([{ url: "https://example.org/source", title: "cited source", cited: true }]);
		expect(evidence.actions()).toHaveLength(1);
	});

	it("ignores malformed, non-web and credential-bearing source URLs", () => {
		const evidence = collectSearchEvidence();
		for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://name:password@example.org", "bad url"]) {
			evidence.observe({ type: "response.output_text.annotation.added", annotation: { type: "url_citation", url } });
		}
		evidence.observe({ type: "response.output_item.added", item: search });
		evidence.observe({ type: "response.output_item.done", item: { ...search, status: "in_progress" } });
		evidence.observe(null);
		expect(evidence.sources()).toEqual([]);
		expect(evidence.searched()).toBe(false);
	});
});
