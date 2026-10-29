// rejects Node-only Vertex ADC proxy routing in browser builds.
import type { GoogleGenAI } from "@google/genai";
import type { ProviderEnv } from "../types.ts";

/** Reject Vertex ADC proxy routing where Node transports are unavailable. */
export function vertexProxyAuthOptions(
	_project: string,
	_env?: ProviderEnv,
): NonNullable<ConstructorParameters<typeof GoogleGenAI>[0]>["googleAuthOptions"] {
	throw new Error("Vertex ADC through a proxy requires Node");
}
