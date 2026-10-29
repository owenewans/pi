import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import webExtension from "../src/extensions/web/index.ts";
import { readWebUrl } from "../src/extensions/web/reader.ts";
import { webSearch } from "../src/extensions/web/search.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

vi.mock("../src/extensions/web/search.ts", () => ({ webSearch: vi.fn() }));
vi.mock("../src/extensions/web/reader.ts", () => ({ readWebUrl: vi.fn() }));

describe("web tools", () => {
	it("registers search and URL reading with provider-compatible object schemas", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			webExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:web",
		);
		expect([...extension.tools.keys()]).toEqual(["web_search", "read_url"]);
		for (const tool of extension.tools.values()) expect(tool.definition.parameters).toMatchObject({ type: "object" });
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([extension], runtime, process.cwd(), SessionManager.inMemory(), registry);
		const signal = new AbortController().signal;
		vi.mocked(webSearch).mockResolvedValue({ query: "fixture", results: [], used: [], failures: [] });
		await extension.tools
			.get("web_search")!
			.definition.execute(
				"fixture",
				{ query: "fixture", mode: "all", limit: 5 },
				signal,
				undefined,
				runner.createToolContext("fixture", undefined),
			);
		expect(webSearch).toHaveBeenCalledWith("fixture", { engine: undefined, mode: "all", limit: 5, signal });
		vi.mocked(readWebUrl).mockResolvedValue({
			url: "https://example.org/",
			title: "fixture",
			text: "body",
			truncated: false,
		});
		await extension.tools
			.get("read_url")!
			.definition.execute(
				"fixture",
				{ url: "https://example.org/", maxChars: 1000 },
				signal,
				undefined,
				runner.createToolContext("fixture", undefined),
			);
		expect(readWebUrl).toHaveBeenCalledWith("https://example.org/", 1000, signal);
	});
});
