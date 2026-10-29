// serves a disposable SOCKS5 proxy for offline transport tests.
import net, { type Socket } from "node:net";

export async function startSocksProxy(originPort: number) {
	const sockets = new Set<Socket>();
	const destinations: string[] = [];
	const credentials: string[] = [];
	const server = net.createServer((client) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		client.on("error", () => {});
		let buffer = Buffer.alloc(0);
		let state: "greeting" | "auth" | "connect" | "tunnel" = "greeting";
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (state === "greeting") {
				if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
				const auth = buffer.subarray(2, 2 + buffer[1]).includes(2);
				buffer = buffer.subarray(2 + buffer[1]);
				state = auth ? "auth" : "connect";
				client.write(Buffer.from([5, auth ? 2 : 0]));
			}
			if (state === "auth") {
				if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
				const usernameLength = buffer[1];
				const passwordLength = buffer[2 + usernameLength];
				if (buffer.length < 3 + usernameLength + passwordLength) return;
				credentials.push(
					`${buffer.subarray(2, 2 + usernameLength)}:${buffer.subarray(3 + usernameLength, 3 + usernameLength + passwordLength)}`,
				);
				buffer = buffer.subarray(3 + usernameLength + passwordLength);
				state = "connect";
				client.write(Buffer.from([1, 0]));
			}
			if (state !== "connect" || buffer.length < 5) return;
			const addressType = buffer[3];
			const length = addressType === 3 ? buffer[4] + 1 : addressType === 1 ? 4 : 16;
			if (buffer.length < 6 + length) return;
			const address =
				addressType === 3
					? buffer.subarray(5, 4 + length).toString()
					: [...buffer.subarray(4, 4 + length)].join(".");
			destinations.push(`${address}:${buffer.readUInt16BE(4 + length)}`);
			const head = buffer.subarray(6 + length);
			state = "tunnel";
			client.removeListener("data", onData);
			client.pause();
			const upstream = net.connect(originPort, "127.0.0.1", () => {
				client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
				if (head.length) upstream.write(head);
				client.pipe(upstream).pipe(client);
				client.resume();
			});
			sockets.add(upstream);
			upstream.on("close", () => {
				sockets.delete(upstream);
				client.destroy();
			});
			upstream.on("error", () => client.destroy());
			client.on("close", () => upstream.destroy());
		};
		client.on("data", onData);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture did not bind");
	return {
		url: `socks5h://fixture-user:fixture-secret@127.0.0.1:${address.port}`,
		destinations,
		credentials,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
