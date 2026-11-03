import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { verifyPatches } from "./apply-patches.mjs";
import autoformat from "./node_modules/@gotgenes/pi-autoformat/src/extension.ts";
import lsp from "./node_modules/@ian-pascoe/pi-lsp/src/index.ts";
import fff from "./node_modules/@ff-labs/pi-fff/src/index.ts";
import fovea from "./node_modules/pi-fovea/src/index.ts";
import { focusSessionScope } from "./node_modules/pi-fovea/src/core/session.ts";

export default async function codeIntelligence(pi: ExtensionAPI): Promise<void> {
	await verifyPatches();
	const require = createRequire(import.meta.url);
	process.env.FOVEA_AST_GREP ??= join(dirname(require.resolve("@ast-grep/cli/package.json")), "ast-grep");
	autoformat(pi);
	lsp(pi);
	fff(pi);
	fovea({
		...pi,
		on: ((event: string, handler: (...args: any[]) => any) =>
			pi.on(event as any, (data: any, ctx: ExtensionContext) =>
				focusSessionScope.run(ctx.sessionManager.getSessionId(), () => handler(data, ctx)),
			)) as ExtensionAPI["on"],
		registerTool: (tool) =>
			pi.registerTool({
				...tool,
				execute: (id, args, signal, update, ctx) =>
					focusSessionScope.run(ctx.sessionManager.getSessionId(), () => tool.execute(id, args, signal, update, ctx)),
			}),
	});
}
