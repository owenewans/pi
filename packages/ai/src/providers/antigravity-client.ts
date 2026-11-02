/*
 * wire headers and baseline metadata adapted from pi-antigravity.
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

import { getProviderEnvValue } from "../utils/provider-env.ts";

export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

export function antigravityEndpoint(): string {
	const raw = getProviderEnvValue("ANTIGRAVITY_BASE_URL") || ANTIGRAVITY_ENDPOINT;
	const url = new URL(raw);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
		throw new Error("Invalid Antigravity endpoint; expected an HTTPS URL");
	}
	return raw.replace(/\/+$/, "");
}

export function antigravityHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent":
			"antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)",
	};
}

export function parseAntigravityAuth(raw: string): {
	token: string;
	projectId: string;
} {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			value &&
			typeof value === "object" &&
			"token" in value &&
			"projectId" in value &&
			typeof value.token === "string" &&
			value.token.trim() &&
			typeof value.projectId === "string" &&
			value.projectId.trim()
		) {
			return { token: value.token, projectId: value.projectId };
		}
	} catch {}
	throw new Error("Invalid Antigravity credentials; expected JSON token and projectId. Run /login antigravity.");
}

export async function antigravityRequest(
	path: string,
	auth: { token: string; projectId: string },
	signal?: AbortSignal,
	fetchOverride: typeof fetch = globalThis.fetch,
): Promise<unknown> {
	signal?.throwIfAborted();
	const deadline = AbortSignal.timeout(15_000);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	if (!/^\/v1internal:[a-zA-Z]+$/.test(path)) throw new Error("Invalid Antigravity request path");
	let response: Response;
	try {
		response = await fetchOverride(`${antigravityEndpoint()}${path}`, {
			method: "POST",
			headers: antigravityHeaders(auth.token),
			body: JSON.stringify({ project: auth.projectId }),
			signal: combined,
		});
	} catch {
		signal?.throwIfAborted();
		throw new Error("Antigravity request failed");
	}
	signal?.throwIfAborted();
	if (!response.ok) throw new Error(`Antigravity request failed (HTTP ${response.status})`);
	try {
		return await response.json();
	} catch {
		signal?.throwIfAborted();
		throw new Error("Invalid Antigravity response");
	}
}
