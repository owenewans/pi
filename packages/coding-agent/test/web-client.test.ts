import { Response } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchService } from "../src/core/http-dispatcher.ts";
import { createSearchClient, fetchWebPage } from "../src/extensions/web/client.ts";

vi.mock("../src/core/http-dispatcher.ts", () => ({ fetchService: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("bounded web transport", () => {
	it("uses the web route and keeps cookies confined to the response host", async () => {
		const request = vi.mocked(fetchService);
		request
			.mockResolvedValueOnce(new Response("home", { headers: { "set-cookie": "session=fixture; Path=/; Secure" } }))
			.mockResolvedValueOnce(new Response("same host"))
			.mockResolvedValueOnce(new Response("other host"));
		const client = createSearchClient(["one.example", "two.example"]);
		await client.get("https://one.example/");
		await client.get("https://one.example/search");
		await client.get("https://two.example/");
		expect(request.mock.calls[0][0]).toBe("web");
		expect(request.mock.calls[1][2]?.headers).toMatchObject({ cookie: "session=fixture" });
		expect(request.mock.calls[2][2]?.headers).not.toHaveProperty("cookie");
	});
	it("rejects an engine redirect outside its allowed HTTPS hosts", async () => {
		const request = vi
			.mocked(fetchService)
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: "https://internal.invalid/" } }),
			);
		await expect(createSearchClient(["one.example"]).get("https://one.example/")).rejects.toThrow(
			"allowed HTTPS hosts",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("replays form fields as encoded POST data", async () => {
		const request = vi.mocked(fetchService).mockResolvedValueOnce(new Response("result"));
		await createSearchClient(["one.example"]).post("https://one.example/", { form: { q: "one & two" } });
		expect(request.mock.calls[0][2]).toMatchObject({
			method: "POST",
			body: "q=one+%26+two",
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});
	});
	it("changes POST to GET on a 303 redirect", async () => {
		const request = vi
			.mocked(fetchService)
			.mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: "/result" } }))
			.mockResolvedValueOnce(new Response("result"));
		await createSearchClient(["one.example"]).post("https://one.example/", { form: { q: "fixture" } });
		expect(request.mock.calls[1][2]).toMatchObject({ method: "GET", body: undefined });
	});
	it("stops after five redirects", async () => {
		const request = vi
			.mocked(fetchService)
			.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
		await expect(fetchWebPage("https://one.example/")).rejects.toThrow("redirect limit");
		expect(request).toHaveBeenCalledTimes(6);
	});
	it("cancels oversized response bodies", async () => {
		vi.mocked(fetchService).mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
		await expect(fetchWebPage("https://one.example/")).rejects.toThrow("2 MiB");
	});
	it.each(["file:///etc/passwd", "https://fixture:private@example.org", "not a URL"])(
		"rejects unsupported URLs before making a request: %s",
		async (url) => {
			await expect(fetchWebPage(url)).rejects.toThrow();
			expect(fetchService).not.toHaveBeenCalled();
		},
	);
	it("does not retry directly or include underlying credentials in errors", async () => {
		vi.mocked(fetchService).mockRejectedValueOnce(new Error("private proxy credential"));
		await expect(fetchWebPage("https://one.example/")).rejects.toThrow(
			"Web request failed through the configured route",
		);
		expect(fetchService).toHaveBeenCalledTimes(1);
	});
	it("observes cancellation before issuing a request", async () => {
		await expect(fetchWebPage("https://one.example/", AbortSignal.abort(new Error("cancelled")))).rejects.toThrow(
			"cancelled",
		);
		expect(fetchService).not.toHaveBeenCalled();
	});
});
