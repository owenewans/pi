// verifies real local, remote and dynamic forwardings through a disposable SSH server.
import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectProxyTunnel } from "../src/core/proxy-tunnel.ts";
import { SshTunnels } from "../src/extensions/ssh/tunnels.ts";
import { createSshFixture, freeSshTestPort, SSHD } from "./ssh-fixture.ts";

let fixture: Awaited<ReturnType<typeof createSshFixture>>;
let origin: http.Server;
let originPort: number;
let tunnels: SshTunnels;
describe.skipIf(!SSHD)("owned SSH tunnels", () => {
	beforeAll(async () => {
		fixture = await createSshFixture();
		origin = http.createServer((_request, response) => response.end("forwarded fixture"));
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const address = origin.address();
		if (!address || typeof address === "string") throw new Error("origin did not bind");
		originPort = address.port;
	});
	beforeEach(() => {
		vi.stubEnv("PATH", `${fixture.bin}:${process.env.PATH}`);
		tunnels = new SshTunnels();
	});
	afterEach(async () => {
		await tunnels.closeAll();
		vi.unstubAllEnvs();
	});
	afterAll(async () => {
		origin.closeAllConnections();
		await new Promise<void>((resolve) => origin.close(() => resolve()));
		await fixture.close();
	});

	it.each(["local", "remote"] as const)(
		"opens, lists and closes a %s forwarding",
		async (type) => {
			const port = await freeSshTestPort();
			const tunnel = await tunnels.open({
				host: "fixture",
				type,
				bindPort: port,
				destinationHost: "127.0.0.1",
				destinationPort: originPort,
			});
			expect(tunnel.state).toBe("running");
			expect(tunnels.list()).toEqual([tunnel]);
			const text = await new Promise<string>((resolve, reject) => {
				const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
					let text = "";
					response.setEncoding("utf8");
					response.on("data", (chunk: string) => {
						text += chunk;
					});
					response.on("end", () => resolve(text));
					response.on("error", reject);
				});
				request.on("error", reject);
			});
			expect(text).toBe("forwarded fixture");
			await tunnels.close(tunnel.id);
			expect(tunnels.list()).toEqual([]);
			await expect(tunnels.close(tunnel.id)).rejects.toThrow("Unknown SSH tunnel");
		},
		30_000,
	);

	it("opens a dynamic SOCKS tunnel and closes all owned processes", async () => {
		const port = await freeSshTestPort();
		await tunnels.open({ host: "fixture", type: "dynamic", bindPort: port });
		const socket = await connectProxyTunnel(`socks5h://127.0.0.1:${port}`, "127.0.0.1", originPort);
		socket.write("GET / HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
		let text = "";
		for await (const chunk of socket) text += chunk.toString();
		expect(text).toContain("forwarded fixture");
		await tunnels.closeAll();
		expect(tunnels.list()).toEqual([]);
	}, 30_000);

	it("reports listener conflicts instead of returning an apparently running tunnel", async () => {
		await expect(
			tunnels.open({
				host: "fixture",
				type: "local",
				bindPort: originPort,
				destinationHost: "127.0.0.1",
				destinationPort: originPort,
			}),
		).rejects.toThrow();
		expect(tunnels.list()).toEqual([]);
	}, 30_000);

	it("cancels an opening tunnel during shutdown and refuses later opens", async () => {
		const starting = tunnels.open({ host: "fixture", type: "dynamic", bindPort: await freeSshTestPort() });
		const outcome = starting.then(
			() => "opened",
			() => "cancelled",
		);
		await tunnels.closeAll();
		expect(await outcome).toBe("cancelled");
		expect(tunnels.list()).toEqual([]);
		await expect(tunnels.open({ host: "fixture", type: "dynamic", bindPort: 1234 })).rejects.toThrow(
			"owner is closed",
		);
	});

	it("rejects malformed destinations and pre-cancelled opens", async () => {
		await expect(tunnels.open({ host: "fixture", type: "local", bindPort: 1234 })).rejects.toThrow("forwarding host");
		await expect(
			tunnels.open({ host: "fixture", type: "dynamic", bindPort: 1234 }, AbortSignal.abort(new Error("cancelled"))),
		).rejects.toThrow("cancelled");
		expect(tunnels.list()).toEqual([]);
	});
});
