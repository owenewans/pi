import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "vertex-response-id",
					candidates: [
						{
							content: { parts: [{ text: "ok" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 1,
						totalTokenCount: 2,
					},
				};
			},
		};

		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}
	}

	return {
		GoogleGenAI,
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { formatUserAgent } from "../src/utils/identity.ts";
import { setProviderProxy } from "../src/utils/proxy-routing.ts";

const PI_USER_AGENT = formatUserAgent();
const model = getModel("google-vertex", "gemini-3-flash-preview");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

const originalGoogleCloudApiKey = process.env.GOOGLE_CLOUD_API_KEY;

beforeEach(() => {
	googleGenAiMock.constructorCalls.length = 0;
	delete process.env.GOOGLE_CLOUD_API_KEY;
});

afterEach(() => {
	setProviderProxy(undefined);
	if (originalGoogleCloudApiKey === undefined) {
		delete process.env.GOOGLE_CLOUD_API_KEY;
	} else {
		process.env.GOOGLE_CLOUD_API_KEY = originalGoogleCloudApiKey;
	}
});

describe("google-vertex api key resolution", () => {
	it("routes file-based ADC through the configured proxy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vertex-auth-"));
		try {
			const file = join(dir, "credentials.json");
			writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "fixture" }));
			setProviderProxy("socks5h://127.0.0.1:1");
			await streamGoogleVertex(model, context, {
				project: "fixture",
				location: "fixture",
				env: { GOOGLE_APPLICATION_CREDENTIALS: file },
			}).result();
			const config = googleGenAiMock.constructorCalls[0] as {
				googleAuthOptions: {
					projectId: string;
					credentials: { type: string };
					clientOptions: { transporterOptions: { agent: (url: URL) => object } };
				};
			};
			expect(config.googleAuthOptions.projectId).toBe("fixture");
			expect(config.googleAuthOptions.credentials.type).toBe("authorized_user");
			expect(
				config.googleAuthOptions.clientOptions.transporterOptions.agent(new URL("https://oauth2.googleapis.com")),
			).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects unsupported ADC sources before any direct metadata request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vertex-auth-"));
		try {
			const file = join(dir, "credentials.json");
			writeFileSync(file, JSON.stringify({ type: "external_account" }));
			setProviderProxy("socks5h://127.0.0.1:1");
			const result = await streamGoogleVertex(model, context, {
				project: "fixture",
				location: "fixture",
				env: { GOOGLE_APPLICATION_CREDENTIALS: file },
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("supports authorized_user and service_account");
			expect(googleGenAiMock.constructorCalls).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("does not probe metadata when the configured credential file is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-vertex-missing-"));
		try {
			setProviderProxy("socks5h://127.0.0.1:1");
			const result = await streamGoogleVertex(model, context, {
				project: "fixture",
				location: "fixture",
				env: { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "missing.json") },
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("credentials file is unavailable or invalid");
			expect(googleGenAiMock.constructorCalls).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to ADC when options.apiKey is a placeholder marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "<authenticated>",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when options.apiKey is the gcp-vertex-credentials marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "gcp-vertex-credentials",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when GOOGLE_CLOUD_API_KEY is a placeholder marker", async () => {
		process.env.GOOGLE_CLOUD_API_KEY = "<authenticated>";

		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("still uses the API key client for real API keys", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("project");
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("location");
	});

	it("does not forward generated Vertex base URL placeholders", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]?.httpOptions).toEqual({
			headers: { "User-Agent": PI_USER_AGENT },
		});
	});

	it("lets explicit headers override the default User-Agent", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
			headers: { "User-Agent": "custom-agent" },
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]?.httpOptions).toEqual({
			headers: { "User-Agent": "custom-agent" },
		});
	});

	it("forwards custom baseUrl to the ADC client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("forwards custom baseUrl to the API key client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("does not append apiVersion when custom baseUrl already includes one", async () => {
		const customModel: Model<"google-vertex"> = {
			...model,
			baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
		};
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			httpOptions: {
				baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
				baseUrlResourceScope: "COLLECTION",
				apiVersion: "",
			},
		});
	});
});
