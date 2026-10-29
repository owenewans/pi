// creates Node HTTP agents for provider SDKs without modifying proxy environment variables.
import type { ClientRequest } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { ProviderEnv } from "../types.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";

/** Return proxy agents for an SDK endpoint, or undefined for explicit direct routing. */
export function createProviderProxyAgents(target: string | URL, env?: ProviderEnv) {
	const proxy = resolveHttpProxyUrlForTarget(target, env);
	if (!proxy) return undefined;
	if (proxy.protocol === "socks5:" || proxy.protocol === "socks5h:") {
		const agent = new PrivateSocksProxyAgent(proxy, { timeout: 15_000 });
		// SAFETY: agent-base implements HTTPS; Smithy's type requires unused node:https.Agent fields.
		return { httpAgent: agent, httpsAgent: agent as unknown as HttpsAgent };
	}
	return {
		httpAgent: new HttpProxyAgent(proxy),
		// SAFETY: agent-base implements HTTPS without declaring unused node:https.Agent fields.
		httpsAgent: new HttpsProxyAgent(proxy) as unknown as HttpsAgent,
	};
}

class PrivateSocksProxyAgent extends SocksProxyAgent {
	override async connect(request: ClientRequest, options: Parameters<SocksProxyAgent["connect"]>[1]) {
		try {
			return await super.connect(request, options);
		} catch {
			throw new Error("SOCKS proxy connection failed");
		}
	}
}
