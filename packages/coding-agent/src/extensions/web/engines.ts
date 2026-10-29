// parses four public search engines; selectors follow the public-domain owencfg implementation.
import { parseHTML } from "linkedom";
import { parseAnubisChallenge, passChallengeUrl, solveAnubis } from "./anubis.ts";
import type { PageResponse, SearchClient } from "./client.ts";

export const ENGINE_NAMES = ["startpage", "duckduckgo", "brave", "marginalia"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];
export type SearchResult = { title: string; url: string; snippet: string; engine: EngineName };
export type Engine = {
	hosts: readonly string[];
	search(query: string, client: SearchClient, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
};

export class EngineUnavailableError extends Error {}

/** The supported engines and their confined search implementations. */
export const ENGINES: Record<EngineName, Engine> = {
	startpage: {
		hosts: ["startpage.com"],
		async search(query, client, limit, signal) {
			const origin = "https://www.startpage.com";
			const home = await clearAnubis(await client.get(origin, { signal }), client, origin, signal);
			const homeDocument = document(home.body);
			const form = [...homeDocument.querySelectorAll("form")].find((item) =>
				item.getAttribute("action")?.includes("search"),
			);
			if (!form) throw new EngineUnavailableError("Startpage search form is unavailable");
			const fields = Object.fromEntries(
				[...form.querySelectorAll("input[name]")].map((input) => [
					input.getAttribute("name")!,
					input.getAttribute("value") ?? "",
				]),
			);
			fields.query = query;
			delete fields.q;
			const action = new URL(form.getAttribute("action") ?? "/sp/search", origin).href;
			const response = await clearAnubis(
				await client.post(action, { form: fields, referer: `${origin}/`, headers: { origin }, signal }),
				client,
				origin,
				signal,
			);
			assertResponse(response, "Startpage");
			const page = document(response.body);
			return collect(
				"startpage",
				[...page.querySelectorAll(".result")].map((node) => {
					const link = node.querySelector("a.result-link");
					return {
						title: text(node, "h2") || link?.textContent || "",
						url: absoluteUrl(link?.getAttribute("href"), origin),
						snippet: text(node, "p"),
					};
				}),
				limit,
			);
		},
	},
	duckduckgo: {
		hosts: ["duckduckgo.com"],
		async search(query, client, limit, signal) {
			const endpoint = "https://lite.duckduckgo.com/lite/";
			const response = await client.post(endpoint, {
				form: { q: query },
				referer: "https://lite.duckduckgo.com/",
				signal,
			});
			if (response.statusCode === 202 || /anomaly\.js|bots use duckduckgo/i.test(response.body))
				throw new EngineUnavailableError("DuckDuckGo served an anti-bot challenge");
			assertResponse(response, "DuckDuckGo");
			const page = document(response.body);
			return collect(
				"duckduckgo",
				[...page.querySelectorAll("a.result-link")].map((link) => {
					let row = link.closest("tr")?.nextElementSibling;
					let snippet = "";
					while (row && !row.querySelector("a.result-link")) {
						snippet = text(row, ".result-snippet");
						if (snippet) break;
						row = row.nextElementSibling;
					}
					return { title: link.textContent ?? "", url: absoluteUrl(link.getAttribute("href"), endpoint), snippet };
				}),
				limit,
			);
		},
	},
	brave: {
		hosts: ["search.brave.com"],
		async search(query, client, limit, signal) {
			const endpoint = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
			const response = await client.get(endpoint, {
				referer: "https://search.brave.com/",
				headers: { cookie: "safesearch=off" },
				signal,
			});
			assertResponse(response, "Brave");
			const page = document(response.body);
			return collect(
				"brave",
				[...page.querySelectorAll('.snippet[data-type="web"]')].map((node) => {
					const link = node.querySelector("a[href]");
					return {
						title: text(node, ".title") || link?.textContent || "",
						url: absoluteUrl(link?.getAttribute("href"), endpoint),
						snippet: text(node, ".snippet-description") || text(node, ".content"),
					};
				}),
				limit,
			);
		},
	},
	marginalia: {
		hosts: ["old-search.marginalia.nu", "marginalia-search.com"],
		async search(query, client, limit, signal) {
			const parameters = new URLSearchParams({
				query,
				profile: "corpo",
				js: "default",
				adtech: "default",
				searchTitle: "default",
				recent: "default",
				sst: "",
			});
			let endpoint = `https://old-search.marginalia.nu/search?${parameters}`;
			let response: PageResponse | undefined;
			try {
				response = await client.get(endpoint, { signal });
			} catch {
				signal?.throwIfAborted();
			}
			if (!response || response.statusCode >= 400) {
				endpoint = `https://marginalia-search.com/search?${new URLSearchParams({ query, profile: "corpo" })}`;
				response = await client.get(endpoint, { signal });
			}
			if (/Wait A Moment|aggressive bot activity/i.test(response.body))
				throw new EngineUnavailableError("Marginalia is rate limiting requests");
			assertResponse(response, "Marginalia");
			const page = document(response.body);
			const cards = [...page.querySelectorAll("section.card.search-result")];
			if (cards.length)
				return collect(
					"marginalia",
					cards.map((card) => {
						const link = card.querySelector("h2 > a.title, h2 > a");
						return {
							title: link?.textContent ?? "",
							url: absoluteUrl(link?.getAttribute("href"), endpoint),
							snippet: text(card, "p.description"),
						};
					}),
					limit,
				);
			return collect(
				"marginalia",
				[...page.querySelectorAll("main h2 > a")].map((link) => {
					const card = link.closest("div[class*='bg-white']");
					const paragraphs = [...(card?.querySelectorAll("p") ?? [])]
						.map((paragraph) => clean(paragraph.textContent ?? "", 500))
						.filter((value) => value && !/^\d[\d,]*\s+words\b/i.test(value));
					return {
						title: link.textContent ?? "",
						url: absoluteUrl(link.getAttribute("href"), endpoint),
						snippet: paragraphs.sort((a, b) => b.length - a.length)[0] ?? "",
					};
				}),
				limit,
			);
		},
	},
};

function document(html: string) {
	const page = parseHTML(html).document;
	for (const node of page.querySelectorAll("script,style,noscript")) node.remove();
	return page;
}

function text(
	node: { querySelector(selector: string): { textContent: string | null } | null },
	selector: string,
): string {
	return node.querySelector(selector)?.textContent ?? "";
}

function clean(value: string, limit: number): string {
	return value
		.replace(/[\u00ad\u200b-\u200f\ufeff]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
}

function absoluteUrl(href: string | null | undefined, base: string): string | undefined {
	if (!href) return undefined;
	try {
		let url = new URL(href.replace(/[\u00ad\u200b]/g, "").trim(), base);
		if ((url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) && url.pathname === "/l/") {
			const target = url.searchParams.get("uddg");
			if (target) url = new URL(target, base);
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function collect(
	engine: EngineName,
	entries: { title: string; url?: string; snippet: string }[],
	limit: number,
): SearchResult[] {
	const seen = new Set<string>();
	const results: SearchResult[] = [];
	for (const entry of entries) {
		const title = clean(entry.title, 300);
		if (!entry.url || !title || seen.has(entry.url)) continue;
		seen.add(entry.url);
		results.push({ engine, title, url: entry.url, snippet: clean(entry.snippet, 500) });
		if (results.length === limit) break;
	}
	return results;
}

function assertResponse(response: PageResponse, engine: string): void {
	if (response.statusCode >= 400) throw new EngineUnavailableError(`${engine} returned HTTP ${response.statusCode}`);
}

async function clearAnubis(
	response: PageResponse,
	client: SearchClient,
	origin: string,
	signal?: AbortSignal,
): Promise<PageResponse> {
	if (!response.body.includes("anubis_challenge") && !response.body.includes("/.within.website/x/cmd/anubis/"))
		return response;
	const challenge = parseAnubisChallenge(response.body);
	if (!challenge) throw new EngineUnavailableError("Unsupported Anubis challenge");
	const solution = await solveAnubis(challenge, signal);
	const passed = await client.get(passChallengeUrl(origin, challenge, solution, response.url), {
		signal,
		referer: origin,
	});
	if (passed.body.includes("anubis_challenge")) throw new EngineUnavailableError("Anubis challenge was rejected");
	return passed;
}
