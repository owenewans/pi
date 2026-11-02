// observes hosted search items without executing or dereferencing returned URLs.
function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function webUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return;
	try {
		const url = new URL(value);
		if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
	} catch {}
	return;
}

export function collectSearchEvidence() {
	const sources = new Map<string, { url: string; title?: string; cited: boolean }>();
	const actions = new Map<
		string,
		{ type: string; query?: string; queries?: string[]; url?: string; pattern?: string }
	>();
	let completed = false;
	const addSource = (value: unknown, cited: boolean) => {
		const data = record(value);
		const url = webUrl(data?.url);
		if (!url || (sources.size >= 100 && !sources.has(url))) return;
		const previous = sources.get(url);
		sources.set(url, {
			url,
			...(typeof data?.title === "string"
				? { title: data.title }
				: previous?.title
					? { title: previous.title }
					: {}),
			cited: cited || previous?.cited || false,
		});
	};
	const annotation = (value: unknown) => {
		if (record(value)?.type === "url_citation") addSource(value, true);
	};
	const item = (value: unknown) => {
		const data = record(value);
		if (data?.type === "web_search_call" && data.status === "completed") {
			completed = true;
			const action = record(data.action);
			if (!action || typeof action.type !== "string") return;
			if (actions.size < 100)
				actions.set(typeof data.id === "string" ? data.id : JSON.stringify(action), {
					type: action.type,
					...(typeof action.query === "string" ? { query: action.query } : {}),
					...(Array.isArray(action.queries)
						? { queries: action.queries.filter((value): value is string => typeof value === "string") }
						: {}),
					...(webUrl(action.url) ? { url: webUrl(action.url) } : {}),
					...(typeof action.pattern === "string" ? { pattern: action.pattern } : {}),
				});
			for (const source of Array.isArray(action.sources) ? action.sources : []) addSource(source, false);
		}
		if (data?.type === "message") {
			for (const part of Array.isArray(data.content) ? data.content : []) {
				const annotations = record(part)?.annotations;
				for (const value of Array.isArray(annotations) ? annotations : []) annotation(value);
			}
		}
	};
	return {
		observe(value: unknown) {
			const event = record(value);
			if (event?.type === "response.output_text.annotation.added") annotation(event.annotation);
			if (event?.type === "response.output_item.done") item(event.item);
			if (event?.type === "response.web_search_call.completed") completed = true;
			if (event?.type === "response.completed" || event?.type === "response.incomplete") {
				const output = record(event.response)?.output;
				for (const value of Array.isArray(output) ? output : []) item(value);
			}
		},
		searched: () => completed,
		sources: () => [...sources.values()],
		actions: () => [...actions.values()],
	};
}
