// validates and stores provider proxy settings without modifying child environments.
let configuredProxy: string | false | undefined;

export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE = "Unsupported proxy protocol; use HTTP, HTTPS, SOCKS5 or SOCKS5h.";

/** Configure provider routing in memory without exporting credentials to child processes. */
export function setProviderProxy(proxy: string | false | undefined): void {
	configuredProxy =
		typeof proxy === "string" && proxy.trim()
			? parseProxyUrl(proxy.trim()).href
			: proxy === false
				? false
				: undefined;
}

/** Read the in-memory provider route; false means explicitly direct. */
export function getConfiguredProviderProxy(): string | false | undefined {
	return configuredProxy;
}

/** Validate a proxy URL without including credentials in errors. */
export function parseProxyUrl(proxy: string): URL {
	let url: URL;
	try {
		url = new URL(proxy);
		decodeURIComponent(url.username);
		decodeURIComponent(url.password);
	} catch {
		throw new Error("Invalid proxy URL");
	}
	if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) {
		throw new Error(UNSUPPORTED_PROXY_PROTOCOL_MESSAGE);
	}
	if (!url.hostname || url.hash || url.search || (url.pathname !== "" && url.pathname !== "/")) {
		throw new Error("Proxy URL must contain only a host, port and optional credentials");
	}
	return url;
}
