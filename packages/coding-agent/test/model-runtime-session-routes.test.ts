import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryModelsStore,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ModelRouteRequest, VirtualModelDefinition } from "../src/core/virtual-models.ts";

function routerFactory(context: { sessionId: string; model: Model<string> }) {
	let calls = 0;
	const requests: ModelRouteRequest[] = [];
	const definition: VirtualModelDefinition = {
		provider: "router",
		id: "auto",
		name: "Auto",
		route(request) {
			requests.push(request);
			return {
				model: context.model,
				thinkingLevel: "high",
				state: { sessionId: context.sessionId, calls: ++calls },
			};
		},
	};
	return { definition, requests };
}

async function createRuntime() {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		models: [
			{ id: "parent", maxTokens: 100 },
			{ id: "child-a", maxTokens: 200 },
			{ id: "child-b", maxTokens: 300, reasoning: true },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	const parent = routerFactory({ sessionId: "parent", model: runtime.getModel("faux", "parent")! });
	const childA = routerFactory({ sessionId: "child-a", model: runtime.getModel("faux", "child-a")! });
	const childB = routerFactory({ sessionId: "child-b", model: runtime.getModel("faux", "child-b")! });
	runtime.registerVirtualModel(parent.definition);
	await runtime.refresh({ allowNetwork: false });
	const virtual = runtime.getModel("router", "auto")!;
	const resolve = (sessionId?: string) =>
		runtime.resolveModel(virtual, [], { reason: "user", thinkingLevel: "off", sessionId });
	return { runtime, faux, parent, childA, childB, virtual, resolve };
}

describe("ModelRuntime session virtual routers", () => {
	it("keeps factory counters and contexts independent for the parent and two children", async () => {
		const { runtime, parent, childA, childB, resolve } = await createRuntime();
		runtime.registerSessionVirtualModel("child-a", childA.definition);
		runtime.registerSessionVirtualModel("child-b", childB.definition);

		expect((await resolve("parent")).state).toEqual({ sessionId: "parent", calls: 1 });
		expect(await resolve("child-a")).toMatchObject({
			model: { id: "child-a" },
			thinkingLevel: "off",
			state: { sessionId: "child-a", calls: 1 },
		});
		expect(await resolve("child-b")).toMatchObject({
			model: { id: "child-b" },
			thinkingLevel: "high",
			state: { sessionId: "child-b", calls: 1 },
		});
		expect((await resolve("child-a")).state).toEqual({ sessionId: "child-a", calls: 2 });
		expect((await resolve()).state).toEqual({ sessionId: "parent", calls: 2 });
		expect((await resolve("unregistered-session")).state).toEqual({ sessionId: "parent", calls: 3 });
		expect(parent.requests).toHaveLength(3);
		expect(childA.requests).toHaveLength(2);
		expect(childB.requests).toHaveLength(1);
	});

	it("changes only routes without changing catalog entries, providers, availability or auth", async () => {
		const { runtime, virtual, childA, resolve } = await createRuntime();
		const providers = runtime.getProviders();
		const models = runtime.getModels();
		const available = runtime.getAvailableSnapshot();
		const credentials = await runtime.listCredentials();
		const auth = await runtime.getAuth("router");
		const authStatus = runtime.getProviderAuthStatus("router");
		runtime.registerSessionVirtualModel("child-a", {
			...childA.definition,
			name: "Child only",
			contextWindow: 17,
			maxTokens: 1,
			input: ["text"],
			thinkingLevels: ["high"],
		});

		expect((await resolve("child-a")).model.id).toBe("child-a");
		expect(runtime.getModel("router", "auto")).toBe(virtual);
		expect(virtual).toMatchObject({ name: "Auto", contextWindow: 0, maxTokens: 0 });
		expect(runtime.getModels()).toEqual(models);
		expect(runtime.getProviders()).toEqual(providers);
		for (const provider of providers) expect(runtime.getProvider(provider.id)).toBe(provider);
		expect(runtime.getAvailableSnapshot()).toBe(available);
		expect(await runtime.listCredentials()).toEqual(credentials);
		expect(await runtime.getAuth("router")).toEqual(auth);
		expect(runtime.getProviderAuthStatus("router")).toEqual(authStatus);
	});

	it("replaces and removes a session route without overwriting another session or the global route", async () => {
		const { runtime, childA, childB, resolve } = await createRuntime();
		runtime.registerSessionVirtualModel("child-a", childA.definition);
		runtime.registerSessionVirtualModel("child-b", childB.definition);
		const replacement = routerFactory({ sessionId: "replacement", model: runtime.getModel("faux", "parent")! });
		runtime.registerSessionVirtualModel("child-a", replacement.definition);

		expect((await resolve("child-a")).state).toEqual({ sessionId: "replacement", calls: 1 });
		expect((await resolve("child-b")).state).toEqual({ sessionId: "child-b", calls: 1 });
		expect((await resolve()).state).toEqual({ sessionId: "parent", calls: 1 });
		runtime.unregisterSessionVirtualModel("child-a", "router", "missing");
		expect((await resolve("child-a")).state).toEqual({ sessionId: "replacement", calls: 2 });
		runtime.unregisterSessionVirtualModel("child-a", "router", "auto");
		runtime.unregisterSessionVirtualModel("child-a", "router", "auto");
		expect((await resolve("child-a")).state).toEqual({ sessionId: "parent", calls: 2 });
		expect((await resolve("child-b")).state).toEqual({ sessionId: "child-b", calls: 2 });
	});

	it("clears all virtual routes of only the specified session and restores the global routes", async () => {
		const { runtime, parent, childA, childB, resolve } = await createRuntime();
		runtime.registerVirtualModel({ ...parent.definition, id: "second" });
		await runtime.refresh({ allowNetwork: false });
		for (const id of ["auto", "second"]) {
			runtime.registerSessionVirtualModel("child-a", { ...childA.definition, id });
			runtime.registerSessionVirtualModel("child-b", { ...childB.definition, id });
		}
		const resolveSecond = (sessionId: string) =>
			runtime.resolveModel(runtime.getModel("router", "second")!, [], {
				reason: "user",
				thinkingLevel: "off",
				sessionId,
			});
		expect((await resolveSecond("child-a")).model.id).toBe("child-a");
		runtime.clearSessionVirtualModels("child-a");
		runtime.clearSessionVirtualModels("missing-session");

		expect((await resolve("child-a")).model.id).toBe("parent");
		expect((await resolveSecond("child-a")).model.id).toBe("parent");
		expect((await resolve("child-b")).model.id).toBe("child-b");
		expect((await resolveSecond("child-b")).model.id).toBe("child-b");
	});

	it("uses sessionId for direct streamSimple routing while preserving limits, thinking and auth isolation", async () => {
		const { runtime, faux, parent, childA, childB, virtual } = await createRuntime();
		runtime.registerSessionVirtualModel("child-a", childA.definition);
		runtime.registerSessionVirtualModel("child-b", childB.definition);
		const seen: (SimpleStreamOptions | undefined)[] = [];
		faux.setResponses(
			Array.from({ length: 3 }, () => (_context, options) => {
				seen.push(options);
				return fauxAssistantMessage("ok");
			}),
		);
		for (const sessionId of ["child-a", "child-b", undefined]) {
			const message = await runtime
				.streamSimple(
					virtual,
					{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
					{ sessionId, maxTokens: 1000, apiKey: "router-key", headers: { "x-router": "private" } },
				)
				.result();
			expect(message).toMatchObject({ provider: "faux", model: sessionId ?? "parent", stopReason: "stop" });
		}

		expect(seen.map((options) => options?.sessionId)).toEqual(["child-a", "child-b", undefined]);
		expect(seen.map((options) => options?.maxTokens)).toEqual([200, 300, 100]);
		expect(seen.map((options) => options?.reasoning)).toEqual([undefined, "high", undefined]);
		for (const options of seen) {
			expect(options?.apiKey).not.toBe("router-key");
			expect(options?.headers?.["x-router"]).toBeUndefined();
		}
		for (const router of [parent, childA, childB]) {
			expect(router.requests).toHaveLength(1);
			expect(router.requests[0]).toMatchObject({ reason: "direct", thinkingLevel: "off" });
			expect(router.requests[0]).not.toHaveProperty("sessionId");
		}
	});

	it("rejects scoped registration for unknown or physical models without adding catalog entries", async () => {
		const { runtime, childA, resolve } = await createRuntime();
		const models = runtime.getModels();
		for (const [provider, id] of [
			["router", "missing"],
			["missing-provider", "auto"],
			["faux", "parent"],
		]) {
			expect(() => runtime.registerSessionVirtualModel("child-a", { ...childA.definition, provider, id })).toThrow(
				`Virtual model ${provider}/${id} is not registered.`,
			);
		}
		expect(runtime.getModels()).toEqual(models);
		expect(runtime.getProvider("missing-provider")).toBeUndefined();
		expect((await resolve("child-a")).model.id).toBe("parent");
	});

	it("still validates scoped physical targets and their configured credentials", async () => {
		const { runtime, childA, virtual, resolve } = await createRuntime();
		for (const model of [virtual, { ...virtual, provider: "faux", id: "missing" }]) {
			runtime.registerSessionVirtualModel("child-a", {
				...childA.definition,
				route: () => ({ model, thinkingLevel: "off" }),
			});
			await expect(resolve("child-a")).rejects.toThrow("which is not a physical model");
		}
		const unauthenticated = fauxProvider({ provider: "unconfigured" });
		runtime.registerNativeProvider({ ...unauthenticated.provider, auth: {} });
		await runtime.refresh({ allowNetwork: false });
		runtime.registerSessionVirtualModel("child-a", {
			...childA.definition,
			route: () => ({ model: unauthenticated.getModel(), thinkingLevel: "off" }),
		});
		await expect(resolve("child-a")).rejects.toThrow("which has no credentials");
		expect((await resolve()).model.id).toBe("parent");
	});
});
