import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import { getConfiguredProviderProxy, parseProxyUrl, setProviderProxy } from "@earendil-works/pi-ai/utils/proxy-routing";
import * as undici from "undici/index.js";
import { connectProxyTunnel } from "./proxy-tunnel.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

export type ProxyService = "providers" | "browser" | "web" | "telegram" | "context7" | "usage" | "models";
export type ProxyOverrides = Partial<Record<ProxyService, string | false>>;

let serviceIdleTimeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS;
let installedDispatcher: undici.Dispatcher | undefined;
let sharedProxy: string | undefined;
let serviceProxies: ProxyOverrides = {};
const serviceDispatchers = new Map<ProxyService, undici.Dispatcher>();

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

/** Apply validated routing atomically without exposing proxy settings through process.env. */
export function applyHttpProxySettings(httpProxy: string | undefined, overrides: ProxyOverrides = {}): void {
	const shared = httpProxy?.trim() ? parseProxyUrl(httpProxy.trim()).href : undefined;
	const validated: ProxyOverrides = {};
	for (const [service, proxy] of Object.entries(overrides)) {
		if (proxy !== undefined) validated[service as ProxyService] = proxy === false ? false : parseProxyUrl(proxy).href;
	}
	setProviderProxy(validated.providers ?? shared);
	sharedProxy = shared;
	serviceProxies = validated;
	closeServiceDispatchers();
}

function closeServiceDispatchers(): void {
	for (const dispatcher of serviceDispatchers.values()) void dispatcher.close().catch(() => dispatcher.destroy());
	serviceDispatchers.clear();
}

/** Return a service's route, with false representing explicitly direct traffic. */
export function getServiceProxy(service: ProxyService): string | false | undefined {
	return serviceProxies[service] ?? sharedProxy;
}

/** Get the dispatcher for a service override or the shared proxy. */
export function getServiceDispatcher(service: ProxyService): undici.Dispatcher {
	let dispatcher = serviceDispatchers.get(service);
	if (!dispatcher) {
		dispatcher = createHttpDispatcher(serviceIdleTimeoutMs, getServiceProxy(service));
		serviceDispatchers.set(service, dispatcher);
	}
	return dispatcher;
}

/** Fetch through a service override or the shared proxy, never through a failure fallback. */
export function fetchService(
	service: ProxyService,
	input: Parameters<typeof undici.fetch>[0],
	init?: Parameters<typeof undici.fetch>[1],
) {
	return undici.fetch(input, { ...init, dispatcher: getServiceDispatcher(service) });
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: undici.Client.Options): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options));
}

function createUndiciOriginDispatcher(origin: string | URL, dispatcherOptions: undici.Pool.Options): undici.Dispatcher {
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

class IdleSocksProxyAgent extends undici.Socks5ProxyAgent {
	private readonly idleTimeoutMs: number;

	constructor(proxy: string, options: undici.Socks5ProxyAgent.Options, idleTimeoutMs: number) {
		super(proxy, options);
		this.idleTimeoutMs = idleTimeoutMs;
	}

	override dispatch(options: undici.Dispatcher.DispatchOptions, handler: undici.Dispatcher.DispatchHandler): boolean {
		// undici's SOCKS agent does not pass pool timeout defaults into its internal pools.
		return super.dispatch(
			{
				...options,
				bodyTimeout: options.bodyTimeout ?? this.idleTimeoutMs,
				headersTimeout: options.headersTimeout ?? this.idleTimeoutMs,
			},
			handler,
		);
	}
}

/** Create a routed dispatcher; an undefined route uses ambient proxy variables. */
export function createHttpDispatcher(timeoutMs: number, proxy: string | false | undefined): undici.Dispatcher {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const options = {
		allowH2: false,
		// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
		proxyTunnel: true,
		bodyTimeout: normalizedTimeoutMs,
		connect: {
			autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
		},
		headersTimeout: normalizedTimeoutMs,
		clientFactory: createUndiciClient,
		factory: createUndiciOriginDispatcher,
	};
	let dispatcher: undici.Dispatcher;
	if (proxy === false) dispatcher = new undici.Agent(options);
	else if (proxy?.startsWith("socks5:")) {
		dispatcher = new undici.Agent({
			...options,
			connect: (target, callback) => {
				const host = target.hostname.replace(/^\[|\]$/g, "");
				const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
				void connectProxyTunnel(proxy, host, port)
					.then((socket) => {
						if (target.protocol !== "https:") return callback(null, socket);
						const tls = connectTls({ socket, servername: target.servername || (isIP(host) ? undefined : host) });
						const onError = (error: Error) => callback(error, null);
						tls.once("secureConnect", () => {
							tls.off("error", onError);
							callback(null, tls);
						});
						tls.once("error", onError);
					})
					.catch((error: Error) => callback(error, null));
			},
		});
	} else if (proxy?.startsWith("socks5h:")) {
		dispatcher = new IdleSocksProxyAgent(
			proxy.replace(/^socks5h:/, "socks5:"),
			{
				...options,
				connect: undici.buildConnector({ ...options.connect, port: Number(parseProxyUrl(proxy).port) || 1080 }),
			},
			normalizedTimeoutMs,
		);
	} else if (proxy) dispatcher = new undici.ProxyAgent({ ...options, uri: proxy });
	else dispatcher = new undici.EnvHttpProxyAgent(options);
	return withUndiciErrorListener(dispatcher);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const dispatcher = createHttpDispatcher(timeoutMs, getConfiguredProviderProxy());
	if (timeoutMs !== serviceIdleTimeoutMs) closeServiceDispatchers();
	serviceIdleTimeoutMs = timeoutMs;
	const previous = installedDispatcher;
	installedDispatcher = dispatcher;
	undici.setGlobalDispatcher(dispatcher);
	if (previous) void previous.close().catch(() => previous.destroy());
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
