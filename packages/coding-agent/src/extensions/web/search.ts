// orchestrates free engine fallback and merges results without changing network routes.
import { createSearchClient } from "./client.ts";
import { ENGINE_NAMES, ENGINES, type EngineName, EngineUnavailableError, type SearchResult } from "./engines.ts";

export type SearchReport = {
	query: string;
	results: SearchResult[];
	used: EngineName[];
	failures: { engine: EngineName; reason: string }[];
};

/** Search selected engines serially until one answers, or all engines concurrently. */
export async function webSearch(
	query: string,
	options: { engine?: EngineName; mode?: "auto" | "all"; limit?: number; signal?: AbortSignal } = {},
): Promise<SearchReport> {
	query = query.trim();
	if (!query) throw new Error("Search query must not be empty");
	const limit = options.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 25)
		throw new Error("Search result limit must be between 1 and 25");
	const timeout = AbortSignal.timeout(90_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const selected = options.engine ? [options.engine] : ENGINE_NAMES;
	const report: SearchReport = { query, results: [], used: [], failures: [] };
	const batches: SearchResult[][] = [];
	const run = async (name: EngineName) => {
		signal.throwIfAborted();
		const engine = ENGINES[name];
		try {
			const results = await engine.search(query, createSearchClient(engine.hosts), limit, signal);
			if (!results.length) return { name, reason: "no results" };
			return { name, results };
		} catch (error) {
			signal.throwIfAborted();
			return { name, reason: error instanceof EngineUnavailableError ? error.message : "request or parsing failed" };
		}
	};
	if (options.mode === "all") {
		const outcomes = await Promise.all(selected.map(run));
		signal.throwIfAborted();
		for (const outcome of outcomes) {
			if (outcome.results) {
				report.used.push(outcome.name);
				batches.push(outcome.results);
			} else report.failures.push({ engine: outcome.name, reason: outcome.reason });
		}
	} else {
		for (const name of selected) {
			const outcome = await run(name);
			if (outcome.results) {
				report.used.push(name);
				batches.push(outcome.results);
				break;
			}
			report.failures.push({ engine: name, reason: outcome.reason });
		}
	}
	if (!batches.length)
		throw new Error(
			`No search engine returned results: ${report.failures.map((failure) => `${failure.engine}: ${failure.reason}`).join("; ")}`,
		);
	const merged = new Map<string, { result: SearchResult; engines: Set<EngineName>; rank: number }>();
	for (const batch of batches)
		batch.forEach((result, rank) => {
			const key = normalizeUrl(result.url);
			const previous = merged.get(key);
			if (previous) {
				previous.engines.add(result.engine);
				previous.rank = Math.min(previous.rank, rank);
				if (result.snippet.length > previous.result.snippet.length) previous.result.snippet = result.snippet;
			} else merged.set(key, { result: { ...result }, engines: new Set([result.engine]), rank });
		});
	report.results = [...merged.values()]
		.sort((a, b) => b.engines.size - a.engines.size || a.rank - b.rank)
		.slice(0, limit)
		.map((entry) => entry.result);
	return report;
}

function normalizeUrl(value: string): string {
	// engine parsers have already validated this wire URL as HTTP(S).
	const url = new URL(value);
	url.hash = "";
	for (const key of [...url.searchParams.keys()])
		if (/^(utm_|fbclid$|gclid$|ref_?src$)/i.test(key)) url.searchParams.delete(key);
	return `${url.hostname.replace(/^www\./, "")}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}
