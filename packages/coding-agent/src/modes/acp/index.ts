// serves ACP over stdio and owns all editor session processes.
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { AcpAgent } from "./agent.ts";

/** Run an ACP endpoint until the editor disconnects. */
export async function runAcp(): Promise<void> {
	let agent: AcpAgent | undefined;
	const output = new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) =>
				process.stdout.write(chunk, (error) => (error ? reject(error) : resolve())),
			);
		},
	});
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			process.stdin.on("data", (chunk: Buffer) => controller.enqueue(chunk));
			process.stdin.once("end", () => controller.close());
			process.stdin.once("error", (error) => controller.error(error));
		},
	});
	const stream = ndJsonStream(output, input);
	const connection = new AgentSideConnection((client) => {
		agent = new AcpAgent(client);
		return agent;
	}, stream);
	try {
		await connection.closed;
	} finally {
		await agent?.close();
	}
}
