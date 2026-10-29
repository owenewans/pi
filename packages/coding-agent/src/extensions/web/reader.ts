// extracts readable text and links from bounded HTML responses without executing page code.
import { parseHTML } from "linkedom";
import { fetchWebPage } from "./client.ts";

export type ReadUrlResult = { url: string; title: string; text: string; truncated: boolean };

/** Read an explicit HTTP(S) page, retaining useful links and bounding model-visible text. */
export async function readWebUrl(url: string, maxChars = 30_000, signal?: AbortSignal): Promise<ReadUrlResult> {
	if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100_000)
		throw new Error("maxChars must be between 1 and 100000");
	const response = await fetchWebPage(url, signal);
	if (response.statusCode >= 400) throw new Error(`URL reader returned HTTP ${response.statusCode}`);
	const mime = response.contentType.split(";", 1)[0].trim().toLowerCase();
	if (
		mime &&
		!mime.startsWith("text/") &&
		!["application/json", "application/xml", "application/xhtml+xml"].includes(mime)
	)
		throw new Error("URL reader only supports text, HTML, JSON and XML");
	let title = "";
	let text = response.body;
	if (mime.includes("html") || (!mime && /<!doctype html|<html|<article|<main/i.test(text))) {
		const document = parseHTML(text).document;
		title = document.querySelector("title")?.textContent?.trim() ?? "";
		for (const node of document.querySelectorAll("script,style,noscript,nav,footer,header,template,svg"))
			node.remove();
		const root =
			document.querySelector("article,main,[role=main]") ??
			document.querySelector("body") ??
			document.documentElement;
		for (const link of root.querySelectorAll("a[href]")) {
			const label = link.textContent?.trim();
			if (!label) continue;
			try {
				const href = new URL(link.getAttribute("href") ?? "", response.url);
				if ((href.protocol === "http:" || href.protocol === "https:") && !href.username && !href.password)
					link.textContent = `${label} (${href.href})`;
			} catch {}
		}
		for (const node of root.querySelectorAll("p,div,section,h1,h2,h3,h4,h5,h6,li,pre,blockquote,tr,br")) {
			node.before(document.createTextNode("\n"));
			node.after(document.createTextNode("\n"));
		}
		text = root.textContent ?? "";
	}
	text = text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const truncated = text.length > maxChars;
	return { url: response.url, title, text: text.slice(0, maxChars), truncated };
}
