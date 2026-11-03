import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync } from "node:fs";
const s = JSON.parse(readFileSync(process.env.CI_SCENARIO, "utf8"));
export default function (pi) {
	const records = [];
	let step = 0;
	let previewPending = false;
	const text = (r) =>
		r?.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") ?? "";
	const call = (tool, args) => fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
	const record = (name, result) => {
		records.push({ name, result, disk: readFileSync(s.file, "utf8") });
		writeFileSync(process.env.CI_RESULTS, JSON.stringify(records, null, 2));
	};
	const route = (context) => {
		const result = context.messages.findLast((m) => m.role === "toolResult");
		if (step === 0) {
			step++;
			return call("write", { path: s.file, content: s.bad });
		}
		if (step === 1) {
			record("write-bad", result);
			if (readFileSync(s.file, "utf8") === s.bad) throw new Error("formatter did not apply");
			if (!new RegExp(s.errorPattern, "i").test(text(result)))
				throw new Error("automatic compiler error missing " + text(result));
			step++;
			return call("hashline_read", { path: s.file });
		}
		if (step === 2) {
			const lines = JSON.parse(text(result)).content.split("\n");
			const line = lines.find((l) => l.includes(s.oldText));
			if (!line) throw new Error("missing hashline target");
			step++;
			return call("hashline_edit", {
				path: s.file,
				edits: [
					{
						op: "replace",
						start: line.split("|")[0],
						lines: [line.slice(line.indexOf("|") + 1).replace(s.oldText, s.newText)],
					},
				],
			});
		}
		if (step === 3) {
			record("hashline-fix", result);
			if (
				result.isError ||
				new RegExp(s.errorPattern, "i").test(text(result)) ||
				!result.details?.code_intelligence?.paths?.length
			)
				throw new Error("hashline pipeline failed " + text(result));
			step++;
			return call("ast_grep_replace", { path: s.file, lang: s.astLang, pattern: "42", rewrite: "43", apply: true });
		}
		if (step === 4 && !previewPending) {
			record("ast-apply", result);
			if (
				result.isError ||
				!readFileSync(s.file, "utf8").includes("43") ||
				!result.details?.code_intelligence?.paths?.length
			)
				throw new Error("AST pipeline failed " + text(result));
			previewPending = true;
			return call("ast_grep_replace", { path: s.file, lang: s.astLang, pattern: "43", rewrite: "999", apply: false });
		}
		if (step === 4 && previewPending) {
			record("ast-preview", result);
			if (result.isError || result.details?.code_intelligence || !readFileSync(s.file, "utf8").includes("43"))
				throw new Error("AST preview mutated or formatted source");
			step++;
			return call("bash", {
				command:
					"python3 -c " +
					JSON.stringify(
						"from pathlib import Path; Path(" + JSON.stringify(s.file) + ").write_text(" + JSON.stringify(s.bad) + ")",
					),
			});
		}
		if (step === 5) {
			record("shell-bad", result);
			if (!new RegExp(s.errorPattern, "i").test(text(result)) || !result.details?.code_intelligence?.paths?.length)
				throw new Error("shell pipeline failed " + text(result));
			step++;
			return call("edit", { path: s.file, edits: [{ oldText: s.oldText, newText: s.newText }] });
		}
		if (step === 6) {
			record("edit-fix", result);
			if (result.isError || new RegExp(s.errorPattern, "i").test(text(result)))
				throw new Error("edit pipeline failed " + text(result));
			step++;
			return call("fovea_focus", { root: s.cwd, query: "main", maxTokens: 800, fresh: true });
		}
		if (step === 7) {
			record("repo-map", result);
			if (result.isError || !text(result).includes("main")) throw new Error("repo map failed " + text(result));
			step++;
			return call("ffgrep", { pattern: "42", limit: 10 });
		}
		if (step === 8) {
			record("fff-search", result);
			if (result.isError || !text(result).includes(s.name)) throw new Error("FFF failed " + text(result));
			step++;
			return call("lsp_document_symbols", { file_path: s.file });
		}
		if (step === 9) {
			record("lsp-symbols", result);
			if (result.isError || !text(result).includes("main")) throw new Error("LSP failed " + text(result));
			step++;
			return call("tool_search", { query: "lsp_capabilities", limit: 1 });
		}
		if (step === 10) {
			record("advanced-discovery", result);
			if (result.isError || !text(result).includes("lsp_capabilities"))
				throw new Error("LSP discovery failed " + text(result));
			step++;
			return call("lsp_capabilities", {
				file_path: s.file,
				server_id: {
					c: "clangd",
					go: "go",
					rust: "rust",
					javascript: "typescript",
					typescript: "typescript",
					python: "python",
				}[s.language],
			});
		}
		record("advanced-capabilities", result);
		if (result.isError) throw new Error("advanced LSP call failed " + text(result));
		return fauxAssistantMessage("INTEGRATED_CYCLE_OK");
	};
	const p = fauxProvider({ provider: "integrated-code-smoke", models: [{ id: "fixture" }] });
	p.setResponses(Array(40).fill(route));
	pi.registerProvider(p.provider);
}
