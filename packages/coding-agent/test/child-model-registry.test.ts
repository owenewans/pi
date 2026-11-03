import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("child model registry", () => {
	it("binds direct virtual-model streams to the child router", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider();
		runtime.registerNativeProvider(faux.provider);
		const route = vi.fn(() => ({ model: faux.getModel(), thinkingLevel: "off" as const }));
		const childRoute = vi.fn(() => ({ model: faux.getModel(), thinkingLevel: "off" as const }));
		const definition = { provider: "router", id: "auto", name: "Auto", route };
		runtime.registerVirtualModel(definition);
		await runtime.refresh({ allowNetwork: false });
		runtime.registerSessionVirtualModel("child", { ...definition, route: childRoute });
		const registry = new ModelRegistry(runtime, { readOnly: true, sessionId: "child" });
		faux.setResponses([fauxAssistantMessage("routed child")]);
		const virtual = registry.find("router", "auto")!;
		expect(await registry.streamSimple(virtual, { messages: [] }).result()).toMatchObject({
			content: [{ type: "text", text: "routed child" }],
		});
		expect(childRoute).toHaveBeenCalledTimes(1);
		expect(route).not.toHaveBeenCalled();
		runtime.clearSessionVirtualModels("child");
	});
	it("keeps model lookup and streaming without exposing parent catalog mutations", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const faux = fauxProvider();
		runtime.registerNativeProvider(faux.provider);
		const registry = new ModelRegistry(runtime, { readOnly: true });
		const model = faux.getModel();
		expect(registry.find(model.provider, model.id)).toEqual(model);
		faux.setResponses([fauxAssistantMessage("child response")]);
		expect(await registry.streamSimple(model, { messages: [] }).result()).toMatchObject({
			content: [{ type: "text", text: "child response" }],
		});
		const mutations = [
			"registerProvider",
			"registerNativeProvider",
			"unregisterProvider",
			"registerVirtualModel",
			"unregisterVirtualModel",
		] as const;
		const spies = mutations.map((name) => vi.spyOn(runtime, name));
		const router = {
			provider: "router",
			id: "auto",
			name: "Auto",
			route: () => ({ model, thinkingLevel: "off" as const }),
		};
		try {
			for (const mutate of [
				() => registry.registerProvider(faux.provider),
				() => registry.registerProvider("other", { api: "openai-completions", models: [] }),
				() => registry.unregisterProvider(model.provider),
				() => registry.registerVirtualModel(router),
				() => registry.unregisterVirtualModel("router", "auto"),
			])
				expect(mutate).toThrow("cannot change the model registry");
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			expect(runtime.getModel(model.provider, model.id)).toEqual(model);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
