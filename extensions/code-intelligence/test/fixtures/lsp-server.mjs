let input = Buffer.alloc(0);
let document;
let checked = false;
const mode = process.env.FIXTURE_MODE;
const send = (message) => {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const publish = (version, message) =>
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri: document.uri,
			...(version === undefined ? {} : { version }),
			diagnostics: [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message, severity: 1 },
			],
		},
	});
const progress = (kind) =>
	send({
		jsonrpc: "2.0",
		method: "$/progress",
		params: { token: "rustAnalyzer/CheckOnSave", value: { kind, title: "cargo check" } },
	});
function handle(message) {
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				capabilities: {
					textDocumentSync: { openClose: true, change: 1, save: true },
					...(mode === "rust"
						? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }
						: {}),
				},
			},
		});
	} else if (message.method === "textDocument/didOpen") document = message.params.textDocument;
	else if (message.method === "textDocument/didChange")
		document = { ...message.params.textDocument, text: message.params.contentChanges[0].text };
	else if (message.method === "textDocument/didSave") {
		if (mode === "rust") {
			progress("begin");
			setTimeout(() => {
				checked = true;
				publish(document.version, "current error");
				progress("end");
			}, 100);
		} else if (mode === "unversioned") setTimeout(() => publish(undefined, "unproven old error"), 5);
		else {
			setTimeout(() => publish(document.version - 1, "stale error"), 5);
			setTimeout(() => publish(document.version, "current error"), 70);
		}
	} else if (message.method === "textDocument/diagnostic") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				kind: "full",
				items: checked
					? [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
								message: "current error",
								severity: 1,
							},
						]
					: [],
			},
		});
	} else if (message.method === "shutdown") send({ jsonrpc: "2.0", id: message.id, result: null });
	else if (message.method === "exit") process.exit(0);
	else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });
}
process.stdin.on("data", (chunk) => {
	input = Buffer.concat([input, chunk]);
	for (;;) {
		const end = input.indexOf("\r\n\r\n");
		if (end < 0) return;
		const size = Number(
			input
				.subarray(0, end)
				.toString()
				.match(/Content-Length: (\d+)/i)?.[1],
		);
		if (input.length < end + 4 + size) return;
		const body = input.subarray(end + 4, end + 4 + size);
		input = input.subarray(end + 4 + size);
		handle(JSON.parse(body));
	}
});
