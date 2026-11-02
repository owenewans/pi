import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import antigravityExtension from "../../src/extensions/antigravity/index.ts";
import codexSearchExtension from "../../src/extensions/codex-search/index.ts";
import subagentsExtension from "../../src/extensions/subagents/index.ts";
import workflowExtension from "../../src/extensions/workflow/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("native tools through pi-schema validation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function call(name: string, args: JsonObject) {
		const harness = await createHarness({
			extensionFactories: [workflowExtension, subagentsExtension, codexSearchExtension, antigravityExtension],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("fixture finished"),
		]);
		await harness.session.prompt("run the fixture tool");
		return { harness, result: getToolResult(harness, name) };
	}

	it("coerces a single task into an array before native todo execution", async () => {
		const { harness, result } = await call("todo", { items: { text: "verify migration", state: "active" } });
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe("active: verify migration");
		const tasks = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === "tasks");
		expect(tasks).toMatchObject({ data: [{ text: "verify migration", state: "active" }] });
	});

	it.each<[string, JsonObject]>([
		["codex_search", { query: "fixture", mode: "invalid" }],
		["google_search", { thinking: "invalid" }],
		["subagent", { action: "start", tasks: [{ role: "invalid", task: "fixture" }] }],
		["ask", { questions: [{ choices: ["fixture"] }] }],
	])("rejects malformed %s arguments before execution", async (name, args) => {
		const { result } = await call(name, args);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain(`Validation failed for tool "${name}"`);
	});
});
