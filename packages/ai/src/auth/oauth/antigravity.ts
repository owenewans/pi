/**
 * Antigravity OAuth, adapted from pi-antigravity.
 *
 * MIT License
 *
 * Copyright (c) 2026 Rahul Arya
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { createHash } from "node:crypto";
import { antigravityEndpoint, antigravityHeaders } from "../../providers/antigravity-client.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { type OAuthCallbackServer, startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"].map(
	(scope) => `https://www.googleapis.com/auth/${scope}`,
);

type Json = Record<string, unknown>;

function env(name: string): string | undefined {
	return getProviderEnvValue(`ANTIGRAVITY_${name}`) || getProviderEnvValue(`NOAGY_${name}`);
}

function client(): Record<string, string> {
	// google's public desktop client; these are not private application credentials.
	return {
		client_id: env("CLIENT_ID") || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
		client_secret: env("CLIENT_SECRET") || "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",
	};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function object(value: unknown): Json {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function defaultProjectId(email: unknown): string {
	const override = env("PROJECT_ID")?.trim();
	if (override) return override;
	const bytes = createHash("sha1")
		.update(`antigravity:${text(email) || "antigravity-default"}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function projectId(value: unknown): string | undefined {
	const data = object(value);
	for (const key of [
		"antigravityProjectId",
		"projectId",
		"backendProjectId",
		"userDefinedCloudaicompanionProject",
		"cloudaicompanionProject",
		"project",
	]) {
		const id = text(data[key]) || text(object(data[key]).id);
		if (id) return id;
	}
	for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
		if (!Array.isArray(data[key])) continue;
		for (const item of data[key]) {
			const id = text(item) || projectId(item);
			if (id) return id;
		}
	}
	return undefined;
}

async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Json> {
	signal.throwIfAborted();
	try {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
		});
		// never include provider bodies, credentials or transport errors in diagnostics.
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return object(await response.json());
	} catch {
		signal.throwIfAborted();
		throw new Error("Antigravity OAuth request failed or timed out");
	}
}

async function exchange(
	fields: Record<string, string>,
	signal: AbortSignal,
	previous?: OAuthCredential,
): Promise<OAuthCredential> {
	const data = await request(
		TOKEN_URL,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ ...client(), ...fields }).toString(),
		},
		signal,
	);
	const access = text(data.access_token);
	const refresh = text(data.refresh_token) || previous?.refresh;
	if (
		!access ||
		!refresh ||
		typeof data.expires_in !== "number" ||
		!Number.isFinite(data.expires_in) ||
		data.expires_in <= 0
	) {
		throw new Error("Antigravity OAuth token response missing required fields");
	}
	return {
		...previous,
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + data.expires_in * 1000 - 300_000,
	};
}

async function discover(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const headers = {
		Authorization: `Bearer ${credential.access}`,
		"content-type": "application/json",
	};
	let email = text(credential.email);
	let project = text(credential.projectId);
	if (!email) {
		try {
			email = text(
				(await request("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", { headers }, signal)).email,
			);
		} catch {
			signal.throwIfAborted();
		}
	}
	for (const rpc of ["loadCodeAssist", "listCloudAICompanionProjects"]) {
		if (project) break;
		try {
			project = projectId(
				await request(
					`${antigravityEndpoint()}/v1internal:${rpc}`,
					{
						method: "POST",
						headers: antigravityHeaders(credential.access),
						body: JSON.stringify(
							rpc === "loadCodeAssist"
								? {
										metadata: {
											ideType: "ANTIGRAVITY",
											ideVersion: "cli",
											extensionVersion: "cli",
										},
									}
								: {},
						),
					},
					signal,
				),
			);
		} catch {
			signal.throwIfAborted();
		}
	}
	return {
		...credential,
		email,
		projectId: project || defaultProjectId(email),
	};
}

function manualCode(input: string, state: string): string {
	const value = input.trim();
	let params: URLSearchParams;
	try {
		params = new URL(value).searchParams;
	} catch {
		params = new URLSearchParams(value.replace(/^\?/, ""));
	}
	if (params.get("state") !== state) throw new Error("Antigravity OAuth state mismatch");
	if (params.has("error")) throw new Error("Antigravity authorization failed");
	const code = params.get("code");
	if (!code) throw new Error("Missing authorization code in callback URL");
	return code;
}

async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(300_000)]);
	signal.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	let callback: OAuthCallbackServer<string> | undefined;
	try {
		callback = await startOAuthCallbackServer({
			providerName: "Antigravity",
			host: "127.0.0.1",
			redirectHost: "localhost",
			port: 51121,
			path: "/oauth-callback",
			state,
			signal,
			complete: async (code) => code,
		});
	} catch (error) {
		signal.throwIfAborted();
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
	}
	// keep cancellation and the login deadline active even when the port is occupied.
	let onAbort: (() => void) | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("Antigravity login cancelled or timed out"));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try {
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.search = new URLSearchParams({
			client_id: client().client_id,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			access_type: "offline",
			prompt: "consent",
		}).toString();
		interaction.notify({
			type: "auth_url",
			url: url.toString(),
			instructions: "Sign in with Google, or paste the full callback URL from a remote browser.",
		});
		const result = await Promise.race([
			cancelled,
			waitForCallbackOrManualInput(
				{
					...interaction,
					signal,
					prompt: (prompt) =>
						interaction.prompt({
							...prompt,
							signal: AbortSignal.any([signal, ...(prompt.signal ? [prompt.signal] : [])]),
						}),
				},
				callback,
				{
					message: "Paste the full callback URL if the browser cannot reach this machine:",
					placeholder: REDIRECT_URI,
				},
			),
		]);
		const code = result.type === "callback" ? result.value : manualCode(result.input, state);
		return await discover(
			await exchange(
				{
					code,
					code_verifier: verifier,
					grant_type: "authorization_code",
					redirect_uri: REDIRECT_URI,
				},
				signal,
			),
			signal,
		);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		callback?.close();
	}
}

export const antigravityOAuth: OAuthAuth = {
	name: "Antigravity (Google)",
	loginLabel: "Sign in with Google",
	login,
	async refresh(credential, signal) {
		const updated = await exchange(
			{ grant_type: "refresh_token", refresh_token: credential.refresh },
			signal,
			credential,
		);
		if (text(updated.projectId)) return updated;
		return discover(updated, signal);
	},
	async toAuth(credential) {
		return {
			apiKey: JSON.stringify({
				token: credential.access,
				projectId: text(credential.projectId) || defaultProjectId(credential.email),
			}),
		};
	},
};
