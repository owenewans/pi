import { describe, expect, it, vi } from "vitest";
import type { PageResponse, SearchClient } from "../src/extensions/web/client.ts";
import { ENGINES } from "../src/extensions/web/engines.ts";

const page = (body: string, statusCode = 200): PageResponse => ({
	body,
	statusCode,
	url: "https://www.startpage.com/",
	contentType: "text/html",
});
const client = () => ({ get: vi.fn<SearchClient["get"]>(), post: vi.fn<SearchClient["post"]>() });

describe("public search parsers", () => {
	it("replays Startpage's form fields and removes embedded CSS", async () => {
		const fixture = client();
		fixture.get.mockResolvedValue(page('<form action="/sp/search"><input name="token" value="fixture"></form>'));
		fixture.post.mockResolvedValue(
			page(
				'<div class="result"><h2><style>hidden CSS</style>Result title</h2><a class="result-link" href="https://example.org/a">link</a><p>A useful summary</p></div>',
			),
		);
		expect(await ENGINES.startpage.search("one & two", fixture, 10)).toEqual([
			{ engine: "startpage", title: "Result title", url: "https://example.org/a", snippet: "A useful summary" },
		]);
		expect(fixture.post).toHaveBeenCalledWith(
			"https://www.startpage.com/sp/search",
			expect.objectContaining({ form: { token: "fixture", query: "one & two" } }),
		);
	});
	it("clears a bounded Anubis challenge before replaying the form", async () => {
		const fixture = client();
		fixture.get
			.mockResolvedValueOnce(
				page(
					'<script id="anubis_challenge">{"challenge":{"id":"fixture","randomData":"test"},"rules":{"difficulty":1}}</script>',
				),
			)
			.mockResolvedValueOnce(page('<form action="/sp/search"></form>'));
		fixture.post.mockResolvedValue(
			page('<div class="result"><h2>Answer</h2><a class="result-link" href="https://example.org">link</a></div>'),
		);
		expect(await ENGINES.startpage.search("fixture", fixture, 10)).toHaveLength(1);
		expect(fixture.get.mock.calls[1][0]).toContain("/api/pass-challenge?");
	});
	it("unwraps DuckDuckGo links and reads the next snippet row", async () => {
		const fixture = client();
		fixture.post.mockResolvedValue(
			page(
				'<table><tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdoc">Doc</a></td></tr><tr><td class="result-snippet">Snippet</td></tr></table>',
			),
		);
		expect(await ENGINES.duckduckgo.search("fixture", fixture, 10)).toEqual([
			{ engine: "duckduckgo", title: "Doc", url: "https://example.org/doc", snippet: "Snippet" },
		]);
	});
	it("reports DuckDuckGo bot challenges instead of inventing results", async () => {
		const fixture = client();
		fixture.post.mockResolvedValue(page("bots use duckduckgo", 202));
		await expect(ENGINES.duckduckgo.search("fixture", fixture, 10)).rejects.toThrow("anti-bot");
	});
	it("parses Brave web cards and drops invalid or duplicate URLs", async () => {
		const fixture = client();
		fixture.get.mockResolvedValue(
			page(
				'<div class="snippet" data-type="web"><a href="https://example.org"><span class="title">Brave result</span></a><div class="snippet-description">Summary</div></div><div class="snippet" data-type="web"><a href="javascript:bad">Invalid</a></div><div class="snippet" data-type="web"><a href="https://example.org">Duplicate</a></div>',
			),
		);
		expect(await ENGINES.brave.search("fixture", fixture, 10)).toEqual([
			{ engine: "brave", title: "Brave result", url: "https://example.org/", snippet: "Summary" },
		]);
	});
	it("parses Marginalia's legacy cards", async () => {
		const fixture = client();
		fixture.get.mockResolvedValue(
			page(
				'<section class="card search-result"><h2><a class="title" href="https://example.org">Marginalia</a></h2><p class="description">Summary</p></section>',
			),
		);
		expect(await ENGINES.marginalia.search("fixture", fixture, 10)).toEqual([
			{ engine: "marginalia", title: "Marginalia", url: "https://example.org/", snippet: "Summary" },
		]);
	});
	it("tries Marginalia's current host after a legacy transport failure", async () => {
		const fixture = client();
		fixture.get
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(
				page(
					'<main><div class="bg-white"><h2><a href="https://example.org">Current result</a></h2><p>100 words</p><p>Actual summary</p></div></main>',
				),
			);
		expect(await ENGINES.marginalia.search("fixture", fixture, 10)).toEqual([
			{ engine: "marginalia", title: "Current result", url: "https://example.org/", snippet: "Actual summary" },
		]);
		expect(fixture.get.mock.calls[1][0]).toContain("marginalia-search.com/search?");
	});
});
