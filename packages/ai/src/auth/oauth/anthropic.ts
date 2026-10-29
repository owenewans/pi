/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { Type } from "typebox";
import { Check } from "typebox/value";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
// Preferred so the port can be forwarded into containers or over SSH. Anthropic accepts any loopback port,
// so login falls back to a free port when this one cannot be bound (#10571).
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_BROWSER_LOGIN_METHOD = "browser";
const ANTHROPIC_COPY_CODE_LOGIN_METHOD = "copy_code";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

const tokenSchema = Type.Object({
	access_token: Type.String({ minLength: 1 }),
	refresh_token: Type.Optional(Type.String({ minLength: 1 })),
	expires_in: Type.Number({ exclusiveMinimum: 0 }),
});

async function postTokenRequest(body: Record<string, string>, signal: AbortSignal): Promise<string> {
	const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
	if (body.grant_type === "refresh_token") {
		headers["anthropic-beta"] = "oauth-2025-04-20";
		headers["User-Agent"] = "anthropic-sdk-typescript/0.112.1 userOAuthProvider";
	}
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
		});
	} catch {
		signal.throwIfAborted();
		throw new Error("Anthropic OAuth request failed; check the connection and proxy");
	}
	if (!response.ok) throw new Error(`Anthropic OAuth HTTP ${response.status}`);
	return response.text();
}

function parseTokenResponse(responseBody: string, previousRefresh?: string): OAuthCredential {
	let data: unknown;
	try {
		data = JSON.parse(responseBody);
	} catch {
		throw new Error("Anthropic OAuth returned invalid JSON");
	}
	// token responses cross a network-input boundary; never include their contents in errors.
	if (!Check(tokenSchema, data)) throw new Error("Anthropic OAuth returned invalid token data");
	const refresh = data.refresh_token ?? previousRefresh;
	if (!refresh) throw new Error("Anthropic OAuth returned no refresh token");
	return {
		type: "oauth",
		refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - Math.min(5 * 60 * 1000, data.expires_in * 500),
	};
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const responseBody = await postTokenRequest(
		{
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		},
		signal,
	);
	return parseTokenResponse(responseBody);
}

async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const startCallbackServer = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Anthropic",
			host: CALLBACK_HOST,
			port,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			state: verifier,
			complete: async (code) => code,
			signal: interaction.signal,
		});
	// Without a callback server, login continues with the pasted redirect URL.
	const callback = await startCallbackServer(CALLBACK_PORT)
		.catch(() => startCallbackServer(0))
		.catch(() => undefined);
	const redirectUri = callback?.redirectUri ?? REDIRECT_URI;

	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: redirectUri,
		});
		let code: string | undefined;
		let state = verifier;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, state, verifier, redirectUri, interaction.signal);
	} finally {
		callback?.close();
	}
}

async function loginAnthropicCopyCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: COPY_CODE_REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});
	interaction.notify({
		type: "auth_url",
		url: `${AUTHORIZE_URL}?${authParams.toString()}`,
		instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
	});

	const input = await interaction.prompt({
		type: "manual_code",
		message: "Paste the code Anthropic shows after you sign in:",
		placeholder: "code#state",
		signal: interaction.signal,
	});
	const parsed = parseAuthorizationInput(input);
	if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
	if (!parsed.code) throw new Error("Missing authorization code");
	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	return await exchangeAuthorizationCode(
		parsed.code,
		parsed.state ?? verifier,
		verifier,
		COPY_CODE_REDIRECT_URI,
		interaction.signal,
	);
}

/**
 * Refresh Anthropic OAuth token
 */
async function refreshAnthropicToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	const responseBody = await postTokenRequest(
		{
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	return parseTokenResponse(responseBody, refreshToken);
}

export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,

	async login(interaction) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select Anthropic login method:",
			options: [
				{ id: ANTHROPIC_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: ANTHROPIC_COPY_CODE_LOGIN_METHOD, label: "Copy code login (headless)" },
			],
		});

		if (method === ANTHROPIC_COPY_CODE_LOGIN_METHOD) {
			return loginAnthropicCopyCode(interaction);
		}
		if (method !== ANTHROPIC_BROWSER_LOGIN_METHOD) {
			throw new Error(`Unknown Anthropic login method: ${method}`);
		}

		return loginAnthropic(interaction);
	},

	refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
