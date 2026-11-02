import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { antigravityOAuth } from "../src/auth/oauth/antigravity.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { antigravityHeaders } from "../src/providers/antigravity-client.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const nativeFetch = globalThis.fetch;
const credential: OAuthCredential = {
	type: "oauth",
	access: "old-access-secret",
	refresh: "old-refresh-secret",
	expires: 0,
	projectId: "existing-project",
	email: "user@example.com",
};
const signal = new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function manualInteraction(transform: (url: URL) => string = (url) => url.toString()): ProviderAuthInteraction {
	let callback = "";
	return {
		signal,
		notify(event) {
			if (event.type !== "auth_url") return;
			const auth = new URL(event.url);
			expect(auth.origin).toBe("https://accounts.google.com");
			expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
			expect(auth.searchParams.get("access_type")).toBe("offline");
			expect(auth.searchParams.get("scope")).toContain("/auth/aicode");
			const url = new URL(auth.searchParams.get("redirect_uri") ?? "");
			expect(url.toString()).toBe("http://localhost:51121/oauth-callback");
			url.searchParams.set("state", auth.searchParams.get("state") ?? "");
			url.searchParams.set("code", "authorization-secret");
			callback = transform(url);
		},
		async prompt() {
			return callback;
		},
	};
}

function mockLogin(
	project: unknown = { cloudaicompanionProject: { id: "discovered-project" } },
	listedProjects: unknown = {},
) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === TOKEN_URL)
			return json({
				access_token: "access-secret",
				refresh_token: "refresh-secret",
				expires_in: 3600,
			});
		if (url.includes("userinfo")) return json({ email: "user@example.com" });
		const endpoint = (process.env.ANTIGRAVITY_BASE_URL || "https://daily-cloudcode-pa.googleapis.com").replace(
			/\/+$/,
			"",
		);
		expect(init?.headers).toEqual(antigravityHeaders("access-secret"));
		expect(init?.method).toBe("POST");
		if (url === `${endpoint}/v1internal:listCloudAICompanionProjects`) {
			expect(JSON.parse(String(init?.body))).toEqual({});
			return json(listedProjects);
		}
		expect(url).toBe(`${endpoint}/v1internal:loadCodeAssist`);
		expect(JSON.parse(String(init?.body))).toEqual({
			metadata: {
				ideType: "ANTIGRAVITY",
				ideVersion: "cli",
				extensionVersion: "cli",
			},
		});
		return json(project);
	});
}

describe.sequential("Antigravity OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("accepts manual callbacks, discovers the project and uses public client env overrides", async () => {
		vi.stubEnv("ANTIGRAVITY_CLIENT_ID", "custom-client");
		vi.stubEnv("ANTIGRAVITY_CLIENT_SECRET", "custom-secret");
		const fetch = mockLogin();
		vi.stubGlobal("fetch", fetch);
		const result = await antigravityOAuth.login(manualInteraction());
		expect(result).toMatchObject({
			type: "oauth",
			access: "access-secret",
			refresh: "refresh-secret",
			email: credential.email,
			projectId: "discovered-project",
		});
		const body = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
		expect(body.get("client_id")).toBe("custom-client");
		expect(body.get("client_secret")).toBe("custom-secret");
		expect(body.get("code")).toBe("authorization-secret");
		expect(body.get("code_verifier")).toMatch(/^[\w-]{43}$/);
	});

	it("validates manual state before any exchange", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(
			antigravityOAuth.login(
				manualInteraction((url) => {
					url.searchParams.set("state", "wrong-state");
					return url.toString();
				}),
			),
		).rejects.toThrow(/state mismatch/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("validates loopback state and PKCE, then cancels the manual prompt", async () => {
		const fetch = mockLogin();
		vi.stubGlobal("fetch", fetch);
		let callback: Promise<void> | undefined;
		let challenge: string | null = null;
		let promptSignal: AbortSignal | undefined;
		await antigravityOAuth.login({
			signal,
			notify(event) {
				if (event.type !== "auth_url") return;
				const auth = new URL(event.url);
				challenge = auth.searchParams.get("code_challenge");
				const url = new URL(auth.searchParams.get("redirect_uri") ?? "");
				url.hostname = "127.0.0.1";
				url.searchParams.set("code", "authorization-secret");
				callback = (async () => {
					url.searchParams.set("state", "wrong-state");
					expect((await nativeFetch(url)).status).toBe(400);
					url.searchParams.set("state", auth.searchParams.get("state") ?? "");
					expect((await nativeFetch(url)).status).toBe(200);
				})();
			},
			prompt(prompt) {
				promptSignal = prompt.signal;
				return new Promise(() => {});
			},
		});
		await callback;
		expect(promptSignal?.aborted).toBe(true);
		const body = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
		expect(
			createHash("sha256")
				.update(body.get("code_verifier") ?? "")
				.digest("base64url"),
		).toBe(challenge);
	});

	it("offers manual fallback when the callback port is occupied", async () => {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(51121, "127.0.0.1", resolve));
		try {
			vi.stubGlobal("fetch", mockLogin());
			expect((await antigravityOAuth.login(manualInteraction())).projectId).toBe("discovered-project");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("aborts a pending login", async () => {
		const controller = new AbortController();
		await expect(
			antigravityOAuth.login({
				signal: controller.signal,
				notify() {
					controller.abort();
				},
				prompt: () => new Promise(() => {}),
			}),
		).rejects.toThrow(/cancel/i);
	});

	it.each(["projectId", "backendProjectId", "antigravityProjectId", "userDefinedCloudaicompanionProject", "project"])(
		"parses discovery field %s",
		async (field) => {
			vi.stubGlobal("fetch", mockLogin({ [field]: "project-from-field" }));
			expect((await antigravityOAuth.login(manualInteraction())).projectId).toBe("project-from-field");
		},
	);

	it.each([
		{ projects: [{ projectId: "listed-project" }] },
		{
			cloudaicompanionProjects: [{ id: "ignored", cloudaicompanionProject: "listed-project" }],
		},
		{ projectIds: ["listed-project"] },
	])("discovers accounts whose project is only listed: %j", async (projects) => {
		vi.stubEnv("ANTIGRAVITY_BASE_URL", "https://antigravity.example.test/custom/");
		const fetch = mockLogin({}, projects);
		vi.stubGlobal("fetch", fetch);
		expect((await antigravityOAuth.login(manualInteraction())).projectId).toBe("listed-project");
		expect(fetch.mock.calls.map(([url]) => String(url)).slice(-2)).toEqual([
			"https://antigravity.example.test/custom/v1internal:loadCodeAssist",
			"https://antigravity.example.test/custom/v1internal:listCloudAICompanionProjects",
		]);
	});

	it("lists projects after loadCodeAssist fails without exposing transport errors", async () => {
		const fetch = mockLogin({}, { projects: [{ projectId: "listed-project" }] });
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).endsWith(":loadCodeAssist")) throw new Error("transport-access-secret");
			return fetch(input, init);
		});
		expect((await antigravityOAuth.login(manualInteraction())).projectId).toBe("listed-project");
	});

	it("does not list projects when loadCodeAssist discovers one", async () => {
		const fetch = mockLogin();
		vi.stubGlobal("fetch", fetch);
		expect((await antigravityOAuth.login(manualInteraction())).projectId).toBe("discovered-project");
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("retains metadata and rotated refresh tokens without discovery", async () => {
		const fetch = vi.fn(async () =>
			json({
				access_token: "new-access",
				refresh_token: "rotated-refresh",
				expires_in: 3600,
			}),
		);
		vi.stubGlobal("fetch", fetch);
		const result = await antigravityOAuth.refresh(credential, signal);
		expect(result).toMatchObject({
			...credential,
			access: "new-access",
			refresh: "rotated-refresh",
			expires: expect.any(Number),
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retains the old refresh token when Google does not rotate it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ access_token: "new-access", expires_in: 3600 })),
		);
		expect((await antigravityOAuth.refresh(credential, signal)).refresh).toBe(credential.refresh);
	});

	it("aborts refresh before and during fetch", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(
			async (_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("transport-secret")), { once: true });
					controller.abort();
				}),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(antigravityOAuth.refresh(credential, controller.signal)).rejects.toThrow();
		await expect(antigravityOAuth.refresh(credential, controller.signal)).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("times out refresh requests", async () => {
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_input: unknown, init?: RequestInit) =>
					new Promise<Response>((_, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("transport-secret")));
					}),
			),
		);
		const pending = expect(antigravityOAuth.refresh(credential, signal)).rejects.toThrow(/timed out/);
		await vi.advanceTimersByTimeAsync(30_000);
		await pending;
		vi.restoreAllMocks();
	});

	it("uses the source-compatible stable fallback, not random projects", async () => {
		vi.stubGlobal("fetch", mockLogin({}));
		const first = await antigravityOAuth.login(manualInteraction());
		const second = await antigravityOAuth.login(manualInteraction());
		expect(first.projectId).toBe(second.projectId);
		const bytes = createHash("sha1").update("antigravity:user@example.com").digest().subarray(0, 16);
		bytes[6] = (bytes[6] & 15) | 80;
		bytes[8] = (bytes[8] & 63) | 128;
		expect(String(first.projectId).replaceAll("-", "")).toBe(bytes.toString("hex"));
		const { projectId: _project, ...legacy } = credential;
		expect(JSON.parse((await antigravityOAuth.toAuth(legacy)).apiKey ?? "").projectId).toBe(first.projectId);
	});

	it("retains the stable fallback when both discovery RPCs fail", async () => {
		const fetch = mockLogin();
		const discovery: string[] = [];
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/v1internal:")) {
				discovery.push(url);
				throw new Error("transport-access-secret");
			}
			return fetch(input, init);
		});
		const result = await antigravityOAuth.login(manualInteraction());
		const { projectId: _project, ...legacy } = credential;
		expect(result.projectId).toBe(JSON.parse((await antigravityOAuth.toAuth(legacy)).apiKey ?? "").projectId);
		expect(discovery).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:listCloudAICompanionProjects",
		]);
	});

	it("derives npm-compatible apiKey JSON without exposing refresh or email", async () => {
		expect(await antigravityOAuth.toAuth(credential)).toEqual({
			apiKey: JSON.stringify({
				token: credential.access,
				projectId: credential.projectId,
			}),
		});
	});

	it.each([400, 200])("does not leak provider bodies or tokens for status %s", async (status) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json(
					{
						access_token: credential.access,
						error_description: credential.refresh,
					},
					status,
				),
			),
		);
		const error = await antigravityOAuth.refresh(credential, signal).catch((error: Error) => error);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(credential.access);
		expect(String(error)).not.toContain(credential.refresh);
	});
});
