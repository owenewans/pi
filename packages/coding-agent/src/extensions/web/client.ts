// fetches bounded web pages through service routing with host-scoped cookies and checked redirects.
import { fetchService } from "../../core/http-dispatcher.ts";

export type PageResponse = { url: string; statusCode: number; body: string; contentType: string };
export type FetchOptions = {
	referer?: string;
	headers?: Record<string, string>;
	form?: Record<string, string>;
	signal?: AbortSignal;
};
export type SearchClient = {
	get(url: string, options?: FetchOptions): Promise<PageResponse>;
	post(url: string, options?: FetchOptions): Promise<PageResponse>;
};

const MAX_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0";

/** Create a per-search cookie jar confined to the engine's HTTPS hosts. */
export function createSearchClient(allowedHosts: readonly string[]): SearchClient {
	const cookies = new Map<string, Map<string, string>>();
	return {
		get: (url, options) => request("GET", url, options ?? {}, cookies, allowedHosts),
		post: (url, options) => request("POST", url, options ?? {}, cookies, allowedHosts),
	};
}

/** Read an explicit HTTP(S) URL with the same limits and routing as web search. */
export function fetchWebPage(url: string, signal?: AbortSignal): Promise<PageResponse> {
	return request("GET", url, { signal }, new Map());
}

async function request(
	method: "GET" | "POST",
	value: string,
	options: FetchOptions,
	cookies: Map<string, Map<string, string>>,
	allowedHosts?: readonly string[],
): Promise<PageResponse> {
	const timeout = AbortSignal.timeout(30_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		let url = checkedUrl(value, allowedHosts);
		for (let redirect = 0; redirect <= 5; redirect++) {
			signal.throwIfAborted();
			const headers: Record<string, string> = {
				"user-agent": USER_AGENT,
				accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9",
				"accept-language": "en-US,en;q=0.8",
				...options.headers,
			};
			if (options.referer) headers.referer = options.referer;
			const cookie = [...(cookies.get(url.hostname)?.values() ?? [])].join("; ");
			if (cookie) headers.cookie = cookie;
			const body = method === "POST" && options.form ? new URLSearchParams(options.form).toString() : undefined;
			if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
			const response = await fetchService("web", url, { method, body, headers, signal, redirect: "manual" });
			let jar = cookies.get(url.hostname);
			if (!jar) {
				jar = new Map();
				cookies.set(url.hostname, jar);
			}
			for (const entry of response.headers.getSetCookie()) {
				const pair = entry.split(";", 1)[0];
				const separator = pair.indexOf("=");
				if (separator < 1 || pair.length > 4096) continue;
				const name = pair.slice(0, separator);
				if (/max-age=0(?:;|$)/i.test(entry)) jar.delete(name);
				else if (jar.size < 32 || jar.has(name)) jar.set(name, pair);
			}
			const location = response.headers.get("location");
			if ([301, 302, 303, 307, 308].includes(response.status) && location) {
				await response.body?.cancel();
				if (redirect === 5) throw new Error("Web redirect limit exceeded");
				url = checkedUrl(new URL(location, url).href, allowedHosts);
				if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST"))
					method = "GET";
				continue;
			}
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let size = 0;
			let text = "";
			try {
				while (reader) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.byteLength;
					if (size > MAX_BYTES) throw new Error("Web response exceeds 2 MiB");
					text += decoder.decode(chunk.value, { stream: true });
				}
				text += decoder.decode();
			} finally {
				await reader?.cancel().catch(() => {});
				reader?.releaseLock();
			}
			return {
				url: url.href,
				statusCode: response.status,
				body: text,
				contentType: response.headers.get("content-type") ?? "",
			};
		}
		throw new Error("Web redirect limit exceeded");
	} catch (error) {
		options.signal?.throwIfAborted();
		if (
			error instanceof WebPolicyError ||
			(error instanceof Error && /^(Web redirect limit|Web response exceeds)/.test(error.message))
		)
			throw error;
		throw new Error("Web request failed through the configured route");
	}
}

class WebPolicyError extends Error {}

function checkedUrl(value: string, allowedHosts?: readonly string[]): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WebPolicyError("Invalid web URL");
	}
	if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:"))
		throw new WebPolicyError("Web URLs must use HTTP(S) without embedded credentials");
	if (
		allowedHosts &&
		(url.protocol !== "https:" ||
			!allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)))
	)
		throw new WebPolicyError("Search engine attempted to leave its allowed HTTPS hosts");
	url.hash = "";
	return url;
}
