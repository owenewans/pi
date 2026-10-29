// routes file-based Vertex credentials through the configured provider proxy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoogleGenAI } from "@google/genai";
import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { createProviderProxyAgents } from "./node-proxy-agents.ts";

/** Build a proxy-only authentication transport for supported ADC files. */
export function vertexProxyAuthOptions(
	project: string,
	env?: ProviderEnv,
): NonNullable<ConstructorParameters<typeof GoogleGenAI>[0]>["googleAuthOptions"] {
	const home = getProviderEnvValue("HOME", env);
	const keyFilename =
		getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env) ||
		(home ? join(home, ".config", "gcloud", "application_default_credentials.json") : undefined);
	if (!keyFilename) throw new Error("Vertex ADC through a proxy requires a credentials file");
	let credentials: { type?: unknown };
	try {
		credentials = JSON.parse(readFileSync(keyFilename, "utf8"));
	} catch {
		throw new Error("Vertex ADC credentials file is unavailable or invalid");
	}
	if (!credentials || (credentials.type !== "authorized_user" && credentials.type !== "service_account"))
		throw new Error("Vertex ADC through a proxy supports authorized_user and service_account credentials files");
	return {
		projectId: project,
		// Google Auth validates the fields of the supported credential types.
		credentials: credentials as NonNullable<
			NonNullable<ConstructorParameters<typeof GoogleGenAI>[0]>["googleAuthOptions"]
		>["credentials"],
		clientOptions: {
			transporterOptions: {
				agent: (url: URL) => {
					const agents = createProviderProxyAgents(url, env);
					if (!agents) throw new Error("Vertex authentication proxy is unavailable");
					return url.protocol === "http:" ? agents.httpAgent : agents.httpsAgent;
				},
			},
		},
	};
}
