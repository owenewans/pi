import type { InlineExtension } from "../core/extensions/types.ts";
import antigravityExtension from "./antigravity/index.ts";
import browserExtension from "./browser/index.ts";
import codeExtension from "./code/index.ts";
import codemodeExtension from "./codemode/index.ts";
import codexSearchExtension from "./codex-search/index.ts";
import context7Extension from "./context7/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import notifyExtension from "./notify/index.ts";
import processesExtension from "./processes/index.ts";
import profileExtension from "./profile/index.ts";
import sshExtension from "./ssh/index.ts";
import subagentsExtension from "./subagents/index.ts";
import telegramExtension from "./telegram/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import usageExtension from "./usage/index.ts";
import webExtension from "./web/index.ts";
import workflowExtension from "./workflow/index.ts";
import zedExtension from "./zed/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "antigravity", factory: antigravityExtension, builtin: true },
	{ name: "codex-search", factory: codexSearchExtension, builtin: true },
	{ name: "profile", factory: profileExtension, builtin: true },
	{ name: "browser", factory: browserExtension, builtin: true },
	{ name: "telegram", factory: telegramExtension, builtin: true },
	{ name: "processes", factory: processesExtension, builtin: true },
	{ name: "notify", factory: notifyExtension, replaceable: true, builtin: true },
	{ name: "usage", factory: usageExtension, replaceable: true, builtin: true },
	{ name: "workflow", factory: workflowExtension, builtin: true },
	{ name: "ssh", factory: sshExtension, builtin: true },
	{ name: "context7", factory: context7Extension, builtin: true },
	{ name: "web", factory: webExtension, builtin: true },
	{ name: "code", factory: codeExtension, builtin: true },
	{ name: "subagents", factory: subagentsExtension, builtin: true },
	{ name: "zed", factory: zedExtension, builtin: true },
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
