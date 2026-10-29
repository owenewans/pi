// accesses Context7 directly, without an MCP subprocess.
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { fetchService } from "../../core/http-dispatcher.ts";

export default function context7Extension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "resolve-library-id",
		label: "Resolve library",
		description:
			"Find a Context7 library ID from a package name. Resolve before query-docs unless the user supplied an exact /org/project[/version] ID. At most three calls per question. Queries go to Context7; omit secrets and private code.",
		parameters: Type.Object({ libraryName: Type.String({ minLength: 1 }), query: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal) {
			const text = await requestContext7("libs/search", params, signal);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
	pi.registerTool({
		name: "query-docs",
		label: "Library documentation",
		description:
			"Read current documentation and examples for an exact Context7 library ID. Resolve the ID first unless the user supplied it. Query one topic per call, at most three calls per question. Omit secrets and private code.",
		parameters: Type.Object({
			libraryId: Type.String({ pattern: "^/[^/]+/[^/]+(?:/[^/]+)?$" }),
			query: Type.String({ minLength: 1 }),
		}),
		async execute(_id, params, signal) {
			const text = await requestContext7("context", params, signal);
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}

/** Sends a cancellable documentation request using Context7's v2 HTTP API. */
export async function requestContext7(
	path: "libs/search" | "context",
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<string> {
	const url = new URL(`https://context7.com/api/v2/${path}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const headers: Record<string, string> = {};
	const key = process.env.CONTEXT7_API_KEY;
	if (key) headers.Authorization = `Bearer ${key}`;
	const timeout = AbortSignal.timeout(30_000);
	let response: Awaited<ReturnType<typeof fetchService>>;
	try {
		response = await fetchService("context7", url, {
			headers,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch {
		signal?.throwIfAborted();
		throw new Error("Context7 request failed; check the connection and proxy");
	}
	if (response.status === 401) throw new Error("Context7 authorization failed; set CONTEXT7_API_KEY");
	if (response.status === 429) throw new Error("Context7 quota exceeded; retry after the quota resets");
	if (!response.ok) throw new Error(`Context7 HTTP ${response.status}`);
	const text = await response.text();
	if (!text.trim()) throw new Error("Context7 returned no documentation");
	return text;
}
