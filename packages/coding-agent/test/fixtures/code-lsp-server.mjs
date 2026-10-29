// deterministic language-server fixture with split frames, push/pull diagnostics and cancellation.
let buffer = Buffer.alloc(0);
const documents = new Map();
const pending = new Map();
function send(message) {
	const body = Buffer.from(JSON.stringify(message));
	const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
	process.stdout.write(frame.subarray(0, 7));
	process.stdout.write(frame.subarray(7));
}
function diagnostics(text) {
	return text.includes("broken") ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 1, message: "fixture diagnostic", source: "fixture", code: "fixture-error" }] : [];
}
function handle(message) {
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { textDocumentSync: 2, diagnosticProvider: process.argv.includes("--pull") ? { interFileDependencies: false, workspaceDiagnostics: false } : undefined } } });
	} else if (message.method === "textDocument/didOpen") {
		const document = message.params.textDocument;
		documents.set(document.uri, document);
		send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, version: document.version, diagnostics: diagnostics(document.text) } });
	} else if (message.method === "textDocument/didChange") {
		const document = documents.get(message.params.textDocument.uri);
		const change = message.params.contentChanges[0];
		const lines = document.text.split("\n");
		if (change.range && (change.range.end.line !== lines.length - 1 || change.range.end.character !== lines.at(-1).length)) {
			send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "bad incremental range" }] } });
			return;
		}
		document.text = change.text;
		document.version = message.params.textDocument.version;
		send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, version: document.version, diagnostics: diagnostics(document.text) } });
	} else if (message.method === "textDocument/diagnostic") {
		send({ jsonrpc: "2.0", id: message.id, result: { kind: "full", items: diagnostics(documents.get(message.params.textDocument.uri).text) } });
	} else if (message.method === "textDocument/hover") {
		send({ jsonrpc: "2.0", id: message.id, result: { contents: { kind: "plaintext", value: `fixture hover ${message.params.position.line}:${message.params.position.character}` } } });
	} else if (message.method === "workspace/symbol") {
		send({ jsonrpc: "2.0", id: message.id, result: [{ name: message.params.query, kind: 12 }] });
	} else if (message.method === "fixture/wait") {
		pending.set(message.id, message);
	} else if (message.method === "$/cancelRequest") {
		pending.delete(message.params.id);
	} else if (message.method === "fixture/echo") {
		send({ jsonrpc: "2.0", id: message.id, result: message.params });
	} else if (message.method === "fixture/bad") {
		process.stdout.write("Content-Length: 7\r\n\r\nbroken!");
	} else if (message.method === "shutdown") {
		send({ jsonrpc: "2.0", id: message.id, result: null });
	} else if (message.method === "exit") process.exit(0);
	else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "fixture unsupported method" } });
}
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		handle(message);
	}
});
