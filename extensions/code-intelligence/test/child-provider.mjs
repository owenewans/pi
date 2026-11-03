import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readFileSync, appendFileSync } from "node:fs";
export default function (pi) {
	const root = process.env.STACK_ROOT,
		helper = root + "/helper.go",
		main = root + "/main.go";
	let stage = 0;
	const text = (r) =>
		typeof r.content === "string"
			? r.content
			: r.content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
	const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	const record = (kind, result) => appendFileSync(process.env.STACK_TRACE, JSON.stringify({ kind, result }) + "\n");
	const pos = (name) => {
		const lines = readFileSync(helper, "utf8").split("\n");
		const row = lines.findIndex((l) => l.includes(name + "("));
		return { file_path: helper, line: row + 1, character: lines[row].indexOf(name) + 1 };
	};
	pi.on("session_start", (_e, c) => record("start", { session: c.sessionManager.getSessionId() }));
	pi.on("session_shutdown", (_e, c) => record("shutdown", { session: c.sessionManager.getSessionId() }));
	const route = (context) => {
		const child = context.messages.some((m) => m.role === "system" && JSON.stringify(m).includes("You are a subagent"));
		const users = context.messages
			.filter((m) => m.role === "user")
			.map(text)
			.join("\n");
		const result = context.messages.findLast((m) => m.role === "toolResult");
		if (child) {
			if (users.includes("FOCUS_ONLY")) {
				if (!result) return call("fovea_focus", { root, query: "main", fresh: true });
				if (result.isError) throw Error(text(result));
				record("child-focus", result);
				return fauxAssistantMessage("FOCUS_CHILD_OK");
			}
			if (!result) return call("lsp_find_references", pos("greet"));
			if (result.isError) throw Error(text(result));
			if (result.toolName === "lsp_find_references") {
				if (!text(result).includes("main.go")) throw Error("references missing caller");
				return call("lsp_rename", { ...pos("greet"), new_name: "welcome" });
			}
			if (result.toolName === "lsp_rename") return call("lsp_apply", { preview_id: result.details.preview_id });
			if (
				!result.details?.code_intelligence?.paths?.length ||
				!readFileSync(helper, "utf8").includes("welcome(") ||
				!readFileSync(main, "utf8").includes("welcome(")
			)
				throw Error("child rename pipeline failed");
			record("child-rename", result);
			return fauxAssistantMessage("RENAME_CHILD_OK");
		}
		if (stage === 0) {
			stage++;
			return call("fovea_focus", { root, query: "greet", fresh: true });
		}
		if (stage === 1) {
			if (result.isError) throw Error(text(result));
			record("parent-focus", result);
			stage++;
			return call("subagent", {
				tasks: [{ role: "worker", task: "FOCUS_ONLY: inspect main in this isolated project using the map." }],
			});
		}
		if (stage === 2) {
			if (!users.includes("FOCUS_CHILD_OK")) return fauxAssistantMessage("parent independent work");
			stage++;
			return call("fovea_dwell", { root, factor: 2 });
		}
		if (stage === 3) {
			if (result.isError || /no prior|no focus|expired|fresh focus/i.test(text(result)))
				throw Error("child reset parent map " + text(result));
			record("parent-focus-preserved", result);
			stage++;
			return call("lsp_document_symbols", { file_path: helper });
		}
		if (stage === 4) {
			if (result.isError) throw Error(text(result));
			stage++;
			return call("subagent", {
				tasks: [
					{
						role: "worker",
						task: "RENAME: find references and rename greet to welcome using LSP in this isolated project.",
					},
				],
			});
		}
		if (stage === 5) {
			if (!users.includes("RENAME_CHILD_OK")) return fauxAssistantMessage("parent independent work");
			stage++;
			return call("lsp_hover", pos("welcome"));
		}
		if (stage === 6) {
			if (result.isError || !text(result).includes("welcome")) throw Error("parent LSP failed after child");
			record("parent-lsp-after-child", result);
			stage++;
			return call("ffgrep", { pattern: "welcome" });
		}
		if (stage === 7) {
			if (result.isError || !text(result).includes("main.go")) throw Error("parent FFF stale after child");
			record("parent-fff-after-child", result);
			stage++;
			return call("fovea_focus", { root, query: "welcome", fresh: true });
		}
		if (result.isError || !text(result).includes("welcome")) throw Error("parent map stale after child");
		record("STACK_CHILD_OK", result);
		return fauxAssistantMessage("STACK_CHILD_OK");
	};
	const p = fauxProvider({ provider: "stack-child-smoke", models: [{ id: "fixture" }] });
	p.setResponses(Array(100).fill(route));
	pi.registerProvider(p.provider);
}
