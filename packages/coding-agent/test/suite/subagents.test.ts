// checks child agents with the local faux provider, never a real API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import subagentsExtension from "../../src/extensions/subagents/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

it("returns isolated child output to the parent", async () => {
	harness = await createHarness({ extensionFactories: [{ factory: subagentsExtension }] });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { tasks: [{ role: "scout", task: "inspect the fixture" }] })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("child finding"),
		fauxAssistantMessage("parent answer"),
	]);
	await harness.session.prompt("delegate");
	const result = getToolResult(harness, "subagent");
	expect(result.isError).toBe(false);
	expect(JSON.stringify(result.content)).toContain("child finding");
	expect(JSON.stringify(result.content)).toContain("completed");
});

it("runs independent children concurrently", async () => {
	harness = await createHarness({ extensionFactories: [{ factory: subagentsExtension }] });
	let arrivals = 0;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const child = async () => {
		if (++arrivals === 2) release();
		await gate;
		return fauxAssistantMessage(`child ${arrivals}`);
	};
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", {
					tasks: [
						{ role: "scout", task: "one" },
						{ role: "reviewer", task: "two" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		child,
		child,
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("delegate");
	expect(arrivals).toBe(2);
	expect(getToolResult(harness, "subagent").isError).toBe(false);
}, 10_000);

it("lets a worker write through the real child agent loop", async () => {
	harness = await createHarness({ extensionFactories: [{ factory: subagentsExtension }] });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { tasks: [{ role: "worker", task: "write fixture" }] })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("write", { path: "fixture.txt", content: "child output" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("written"),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("delegate");
	expect(readFileSync(join(harness.tempDir, "fixture.txt"), "utf8")).toBe("child output");
	expect(getToolResult(harness, "subagent").isError).toBe(false);
});
