import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWebPage } from "../src/extensions/web/client.ts";
import { readWebUrl } from "../src/extensions/web/reader.ts";

vi.mock("../src/extensions/web/client.ts", () => ({ fetchWebPage: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("URL reader", () => {
	it("extracts main content and absolute links without scripts, navigation or subresource requests", async () => {
		vi.mocked(fetchWebPage).mockResolvedValueOnce({
			url: "https://example.org/docs/page",
			statusCode: 200,
			contentType: "text/html",
			body: '<html><head><title>Fixture article</title><style>hidden CSS</style></head><body><nav>Navigation</nav><main><h1>Heading</h1><p>Useful content <a href="../guide">Guide</a></p><script>private script</script></main><footer>Footer</footer></body></html>',
		});
		const page = await readWebUrl("https://example.org/redirect");
		expect(page.title).toBe("Fixture article");
		expect(page.url).toBe("https://example.org/docs/page");
		expect(page.text).toContain("Useful content Guide (https://example.org/guide)");
		for (const hidden of ["Navigation", "Footer", "private script", "hidden CSS"])
			expect(page.text).not.toContain(hidden);
		expect(fetchWebPage).toHaveBeenCalledTimes(1);
	});
	it("preserves plain JSON and reports character truncation", async () => {
		vi.mocked(fetchWebPage).mockResolvedValueOnce({
			url: "https://example.org/data",
			statusCode: 200,
			contentType: "application/json",
			body: '{"value":"fixture"}',
		});
		expect(await readWebUrl("https://example.org/data", 8)).toMatchObject({ text: '{"value"', truncated: true });
	});
	it("rejects binary content", async () => {
		vi.mocked(fetchWebPage).mockResolvedValueOnce({
			url: "https://example.org/image",
			statusCode: 200,
			contentType: "image/png",
			body: "binary",
		});
		await expect(readWebUrl("https://example.org/image")).rejects.toThrow("only supports text");
	});
	it("does not expose private HTTP error bodies", async () => {
		vi.mocked(fetchWebPage).mockResolvedValueOnce({
			url: "https://example.org",
			statusCode: 403,
			contentType: "text/plain",
			body: "private response details",
		});
		await expect(readWebUrl("https://example.org")).rejects.toThrow("URL reader returned HTTP 403");
	});
	it.each([0, 100_001, 1.5])("rejects invalid output limits %s before fetching", async (limit) => {
		await expect(readWebUrl("https://example.org", limit)).rejects.toThrow("maxChars");
		expect(fetchWebPage).not.toHaveBeenCalled();
	});
});
