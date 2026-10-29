import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";

const OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS = [
	"~anthropic/claude-fable-latest",
	"~anthropic/claude-haiku-latest",
	"~anthropic/claude-opus-latest",
	"~anthropic/claude-sonnet-latest",
] as const;

describe("OpenRouter Anthropic latest alias metadata", () => {
	it.each(OPENROUTER_ANTHROPIC_LATEST_MODEL_IDS)("uses native Anthropic messages for %s", (modelId) => {
		const model = getModel("openrouter", modelId);
		expect(model.api).toBe("anthropic-messages");
	});
});
