import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINES, type EngineName, EngineUnavailableError, type SearchResult } from "../src/extensions/web/engines.ts";
import { webSearch } from "../src/extensions/web/search.ts";

const result = (engine: EngineName, url = "https://example.org/doc", snippet = "summary"): SearchResult => ({
	engine,
	url,
	snippet,
	title: "fixture result",
});
beforeEach(() => {
	for (const engine of Object.values(ENGINES)) vi.spyOn(engine, "search").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("free search orchestration", () => {
	it("falls back to the first engine with results without changing proxy routes", async () => {
		vi.mocked(ENGINES.startpage.search).mockRejectedValueOnce(new EngineUnavailableError("Startpage unavailable"));
		vi.mocked(ENGINES.duckduckgo.search).mockResolvedValueOnce([result("duckduckgo")]);
		const report = await webSearch("fixture");
		expect(report.used).toEqual(["duckduckgo"]);
		expect(report.failures).toEqual([{ engine: "startpage", reason: "Startpage unavailable" }]);
		expect(ENGINES.brave.search).not.toHaveBeenCalled();
	});
	it("merges all engines, removes tracking duplicates and prefers fuller summaries", async () => {
		vi.mocked(ENGINES.startpage.search).mockResolvedValueOnce([
			result("startpage", "https://www.example.org/doc/?utm_source=fixture", "short"),
		]);
		vi.mocked(ENGINES.brave.search).mockResolvedValueOnce([
			result("brave", "https://example.org/doc", "a longer useful summary"),
		]);
		const report = await webSearch("fixture", { mode: "all" });
		expect(report.used).toEqual(["startpage", "brave"]);
		expect(report.results).toHaveLength(1);
		expect(report.results[0].snippet).toBe("a longer useful summary");
	});
	it("allows selecting exactly one engine", async () => {
		vi.mocked(ENGINES.brave.search).mockResolvedValueOnce([result("brave")]);
		expect((await webSearch("fixture", { engine: "brave" })).used).toEqual(["brave"]);
		expect(ENGINES.startpage.search).not.toHaveBeenCalled();
	});
	it("does not expose arbitrary transport errors", async () => {
		vi.mocked(ENGINES.startpage.search).mockRejectedValueOnce(new Error("private proxy credential"));
		vi.mocked(ENGINES.duckduckgo.search).mockResolvedValueOnce([result("duckduckgo")]);
		const report = await webSearch("fixture");
		expect(JSON.stringify(report)).not.toContain("private proxy credential");
	});
	it("reports failure when every selected engine is unavailable", async () => {
		await expect(webSearch("fixture")).rejects.toThrow("No search engine returned results");
	});
	it("honors cancellation without returning partial results", async () => {
		await expect(
			webSearch("fixture", { mode: "all", signal: AbortSignal.abort(new Error("cancelled")) }),
		).rejects.toThrow("cancelled");
		for (const engine of Object.values(ENGINES)) expect(engine.search).not.toHaveBeenCalled();
	});
	it.each([0, 26, 1.5])("rejects an invalid result limit %s", async (limit) => {
		await expect(webSearch("fixture", { limit })).rejects.toThrow("between 1 and 25");
	});
	it("rejects an empty query", async () => {
		await expect(webSearch(" ")).rejects.toThrow("must not be empty");
	});
});
