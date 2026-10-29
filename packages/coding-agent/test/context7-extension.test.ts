import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import context7Extension, { requestContext7 } from "../src/extensions/context7/index.ts";

vi.mock("../src/core/http-dispatcher.ts", () => ({
	fetchService: (_service: string, input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Context7", () => {
	it("registers library resolution and documentation tools", async () => {
		const extension = await loadExtensionFromFactory(
			context7Extension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"builtin:context7",
		);
		expect([...extension.tools.keys()]).toEqual(["resolve-library-id", "query-docs"]);
	});

	it("encodes library names and queries without putting credentials in URLs", async () => {
		vi.stubEnv("CONTEXT7_API_KEY", "fixture-key");
		const request = vi.fn().mockResolvedValue(new Response('{"results":[]}'));
		vi.stubGlobal("fetch", request);
		expect(await requestContext7("libs/search", { libraryName: "@example/library", query: "one & two" })).toBe(
			'{"results":[]}',
		);
		const [url, options] = request.mock.calls[0];
		expect(url.origin).toBe("https://context7.com");
		expect(url.pathname).toBe("/api/v2/libs/search");
		expect(url.searchParams.get("libraryName")).toBe("@example/library");
		expect(url.searchParams.get("query")).toBe("one & two");
		expect(url.toString()).not.toContain("fixture-key");
		expect(options.headers.Authorization).toBe("Bearer fixture-key");
	});

	it("supports the unauthenticated endpoint without a key", async () => {
		vi.stubEnv("CONTEXT7_API_KEY", "");
		const request = vi.fn().mockResolvedValue(new Response("documentation"));
		vi.stubGlobal("fetch", request);
		expect(await requestContext7("context", { libraryId: "/org/project", query: "setup" })).toBe("documentation");
		const [url, options] = request.mock.calls[0];
		expect(url.pathname).toBe("/api/v2/context");
		expect(url.searchParams.get("libraryId")).toBe("/org/project");
		expect(options.headers.Authorization).toBeUndefined();
	});

	it.each([
		[401, "CONTEXT7_API_KEY"],
		[429, "quota exceeded"],
		[503, "HTTP 503"],
	])("reports HTTP %i without exposing response contents", async (status, message) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private server data", { status })));
		await expect(requestContext7("context", {})).rejects.toThrow(message);
	});

	it("does not retry after transport failure", async () => {
		const request = vi.fn().mockRejectedValue(new Error("private connection details"));
		vi.stubGlobal("fetch", request);
		await expect(requestContext7("context", {})).rejects.toThrow("check the connection and proxy");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects empty documentation", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(" \n")));
		await expect(requestContext7("context", {})).rejects.toThrow("no documentation");
	});

	it("forwards cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(controller.signal.reason));
		await expect(requestContext7("context", {}, controller.signal)).rejects.toThrow("cancelled");
	});
});
