import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { imageTarget, parseImages, requestContent, saveImages } from "../src/extensions/antigravity/helper.ts";
import extension from "../src/extensions/antigravity/index.ts";

const transport = vi.hoisted(() => vi.fn());
vi.mock("../src/core/http-dispatcher.ts", () => ({ fetchService: transport }));
const auth = JSON.stringify({ token: "secret-token", projectId: "project" });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { data: png, mimeType: "image/png" };
const dirs: string[] = [];
async function temporary() {
	const dir = await mkdtemp(join(tmpdir(), "pi-antigravity-test-"));
	dirs.push(dir);
	return dir;
}
function tools(cwd = process.cwd(), key: string | undefined = auth) {
	const registered = new (class extends Map<string, ToolDefinition> {
		get(name: string): ToolDefinition {
			const tool = super.get(name);
			if (!tool) throw new Error(`Missing tool ${name}`);
			return tool;
		}
	})();
	extension({
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd,
		modelRegistry: { getApiKeyForProvider: vi.fn().mockResolvedValue(key) },
	} as unknown as ExtensionToolContext;
	return { registered, ctx };
}
function reply(parts: unknown[], groundingMetadata?: unknown) {
	return new Response(
		JSON.stringify({
			response: { candidates: [{ content: { parts }, groundingMetadata }] },
		}),
	);
}
afterEach(async () => {
	transport.mockReset();
	vi.unstubAllGlobals();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("native Antigravity tools", () => {
	it("always registers exactly the two tools and reports missing OAuth", async () => {
		const { registered, ctx } = tools();
		expect([...registered.keys()]).toEqual(["google_search", "generate_image"]);
		(ctx.modelRegistry.getApiKeyForProvider as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		await expect(
			registered.get("google_search").execute("1", { query: "test" }, undefined, undefined, ctx),
		).rejects.toThrow("/login antigravity");
		expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("antigravity");
		expect(transport).not.toHaveBeenCalled();
	});

	it("uses the providers proxy route and grounding envelope without fetching sources", async () => {
		transport.mockResolvedValue(
			reply([{ thought: true, text: "hidden" }, { text: "Claim" }], {
				groundingChunks: [
					{ other: {} },
					{
						web: {
							uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/token",
							title: "Source",
						},
					},
				],
				groundingSupports: [{ segment: { text: "Claim" }, groundingChunkIndices: [0, 1, 99] }],
				webSearchQueries: ["query"],
			}),
		);
		const direct = vi.fn();
		vi.stubGlobal("fetch", direct);
		const { registered, ctx } = tools();
		const result = await registered.get("google_search").execute(
			"1",
			{
				query: "test",
				instruction: "exact versions",
				urls: ["https://example.com"],
				thinking: true,
			},
			undefined,
			undefined,
			ctx,
		);
		const [route, url, init] = transport.mock.calls[0];
		expect(route).toBe("providers");
		expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
		expect(init.redirect).toBe("error");
		expect(init.headers.Authorization).toBe("Bearer secret-token");
		const body = JSON.parse(init.body);
		expect(body).toMatchObject({
			model: "gemini-3.5-flash-lite",
			project: "project",
			requestType: "agent",
			userAgent: "antigravity",
		});
		expect(body.request.tools).toEqual([{ googleSearch: {} }, { urlContext: {} }]);
		expect(body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(4096);
		const report = JSON.parse((result.content[0] as { text: string }).text);
		expect(report).toMatchObject({
			untrusted: true,
			text: "Claim",
			supports: [{ text: "Claim", sourceIndices: [1] }],
		});
		expect(report.sources[0].url).toContain("grounding-api-redirect/token");
		expect(transport).toHaveBeenCalledTimes(1);
		expect(direct).not.toHaveBeenCalled();
	});

	it("omits thinking config unless requested", async () => {
		transport.mockResolvedValue(reply([{ text: "answer" }]));
		const { registered, ctx } = tools();
		await registered.get("google_search").execute("1", { query: "test" }, undefined, undefined, ctx);
		expect(JSON.parse(transport.mock.calls[0][2].body).request.generationConfig).toEqual({});
	});

	it("saves generated images and returns image blocks", async () => {
		transport.mockResolvedValue(reply([{ inlineData: image }, { text: "notes" }]));
		const cwd = await temporary();
		const { registered, ctx } = tools(cwd);
		const result = await registered
			.get("generate_image")
			.execute("1", { prompt: "tree", aspectRatio: "16:9" }, undefined, undefined, ctx);
		const body = JSON.parse(transport.mock.calls[0][2].body);
		expect(body).toMatchObject({
			model: "gemini-3.1-flash-image",
			requestType: "image_gen",
			request: {
				generationConfig: {
					imageConfig: { aspectRatio: "16:9" },
					candidateCount: 1,
				},
			},
		});
		const { savedPaths } = result.details as { savedPaths: string[] };
		expect(savedPaths[0]).toMatch(/^\.pi\/generated-images\/[a-f0-9-]+\.png$/);
		expect(await readFile(join(cwd, savedPaths[0]))).toEqual(Buffer.from(png, "base64"));
		expect(result.content[1]).toEqual({ type: "image", ...image });
	});

	it.each([401, 403, 404, 429, 503])("does not fail over on HTTP %s or leak server data", async (status) => {
		transport.mockResolvedValue(new Response("secret-token private server data", { status }));
		await expect(requestContent(auth, "model", "agent", {})).rejects.toThrow(`HTTP ${status}`);
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("does not use a direct fallback on proxy failure", async () => {
		transport.mockRejectedValue(new Error("proxy credentials secret-token"));
		const direct = vi.fn();
		vi.stubGlobal("fetch", direct);
		await expect(requestContent(auth, "model", "agent", {})).rejects.toThrow(
			"check the connection and provider proxy",
		);
		expect(transport).toHaveBeenCalledTimes(1);
		expect(direct).not.toHaveBeenCalled();
	});
	it("forwards cancellation and rejects pre-aborted calls", async () => {
		const controller = new AbortController();
		transport.mockImplementation(async (_route, _url, init) => {
			controller.abort(new Error("cancelled"));
			expect(init.signal.aborted).toBe(true);
			init.signal.throwIfAborted();
		});
		await expect(requestContent(auth, "model", "agent", {}, controller.signal)).rejects.toThrow("cancelled");
		await expect(requestContent(auth, "model", "agent", {}, controller.signal)).rejects.toThrow("cancelled");
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it.each(["not json", "{}", '{"response":{"error":{"message":"private"}}}', '{"candidates":[]}'])(
		"rejects malformed responses: %s",
		async (payload) => {
			transport.mockResolvedValue(new Response(payload));
			await expect(requestContent(auth, "model", "agent", {})).rejects.toThrow(/Antigravity/);
		},
	);
	it.each(["bad", "{}", '{"token":"a"}', '{"token":"a\\nb","projectId":"p"}'])(
		"rejects bad credentials",
		async (key) => {
			await expect(requestContent(key, "model", "agent", {})).rejects.toThrow("Invalid Antigravity credentials");
			expect(transport).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ data: "!!!!", mimeType: "image/png" },
		{ data: png, mimeType: "image/svg+xml" },
		{ data: "YWJj", mimeType: "image/png" },
		{ data: png, mimeType: "image/jpeg" },
		{ data: "AB==", mimeType: "image/png" },
	])("rejects bad image payloads", (inlineData) => {
		expect(() => parseImages({ content: { parts: [{ inlineData }] } })).toThrow();
	});
	it("rejects oversized images and responses", async () => {
		expect(() =>
			parseImages({
				content: {
					parts: [{ inlineData: { ...image, data: "A".repeat(14 * 1024 * 1024) } }],
				},
			}),
		).toThrow("base64");
		transport.mockResolvedValue(new Response(new Uint8Array(33 * 1024 * 1024)));
		await expect(requestContent(auth, "model", "agent", {})).rejects.toThrow("size limit");
	});
	it("rejects traversal, absolute paths, symlink escapes and overwrite", async () => {
		const cwd = await temporary();
		const outside = await temporary();
		expect(() => imageTarget(cwd, "../escape.png")).toThrow();
		expect(() => imageTarget(cwd, "/tmp/escape.png")).toThrow();
		await symlink(outside, join(cwd, "link"));
		await expect(saveImages(cwd, imageTarget(cwd, "link/out.png"), [image])).rejects.toThrow("symlink");
		await saveImages(cwd, imageTarget(cwd, "out.png"), [image]);
		await expect(saveImages(cwd, imageTarget(cwd, "out.png"), [image])).rejects.toThrow();
		await symlink(join(outside, "new.png"), join(cwd, "file.png"));
		await expect(saveImages(cwd, imageTarget(cwd, "file.png"), [image])).rejects.toThrow();
	});
	it("validates tool inputs before network requests", async () => {
		const { registered, ctx } = tools();
		for (const params of [{ query: " " }, { query: "x", urls: ["file:///etc/passwd"] }]) {
			await expect(
				registered.get("google_search").execute("1", params, undefined, undefined, ctx),
			).rejects.toThrow();
		}
		for (const params of [
			{ prompt: " " },
			{ prompt: "x", path: "../escape.png" },
			{ prompt: "x", model: "not-image" },
			{ prompt: "x", aspectRatio: "7:7" },
		]) {
			await expect(
				registered.get("generate_image").execute("1", params, undefined, undefined, ctx),
			).rejects.toThrow();
		}
		expect(transport).not.toHaveBeenCalled();
	});
	it("rejects missing image data and honors cancellation before saving", async () => {
		expect(() => parseImages({ content: { parts: [{ text: "refusal" }] } })).toThrow("images");
		const cwd = await temporary();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(saveImages(cwd, imageTarget(cwd, "out.png"), [image], controller.signal)).rejects.toThrow(
			"cancelled",
		);
	});
	it("saves multiple images with distinct requested filenames", async () => {
		const cwd = await temporary();
		const paths = await saveImages(cwd, imageTarget(cwd, "out.png"), [image, image]);
		expect(paths).toEqual(["out-1.png", "out-2.png"]);
	});
});
