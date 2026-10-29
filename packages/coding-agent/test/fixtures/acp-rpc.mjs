// fake pi RPC process for ACP protocol tests.
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
let selected = "one";
input.on("line", (line) => {
	const command = JSON.parse(line);
	const response = (data) => send({ type: "response", id: command.id, command: command.type, success: true, data });
	if (command.type === "get_state") response({ sessionId: process.env.FIXTURE_SESSION || "fixture-session", model: { provider: "fixture", id: selected } });
	else if (command.type === "get_available_models") response({ models: [{ provider: "fixture", id: "one" }, { provider: "fixture", id: "two" }] });
	else if (command.type === "get_messages") response({ messages: [{ role: "user", content: "previous request" }, { role: "assistant", content: [{ type: "text", text: "previous answer" }] }] });
	else if (command.type === "set_model") { selected = command.modelId; response({ provider: command.provider, id: selected }); }
	else if (command.type === "prompt") {
		if (command.message === "noauth") return send({ type: "response", id: command.id, command: command.type, success: false, error: "No API key found for the selected model." });
		response({ disposition: "started" });
		if (command.message === "crash") return process.exit(23);
		if (command.message === "hold") return;
		send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
		send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "file.txt" } });
		send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "contents" }] }, isError: false });
		send({ type: "agent_settled", aborted: false });
	} else if (command.type === "abort") {
		response({});
		send({ type: "agent_settled", aborted: true });
	}
});
