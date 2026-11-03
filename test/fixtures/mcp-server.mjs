import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const cwd = process.argv[process.argv.indexOf("--project") + 1];
const scenario = JSON.parse(readFileSync(join(cwd, ".mcp-scenario.json"), "utf8"));
writeFileSync(join(cwd, ".mcp-pid"), String(process.pid));
appendFileSync(join(cwd, ".mcp-log.jsonl"), `${JSON.stringify({ argv: process.argv.slice(2), pid: process.pid })}\n`);
if (scenario.ignoreTerm) process.on("SIGTERM", () => {});
const send = (id, result, error) => {
	const message = `${JSON.stringify({ jsonrpc: "2.0", id, result, error })}\n`;
	if (scenario.split) {
		process.stdout.write(message.slice(0, 12));
		setTimeout(() => process.stdout.write(message.slice(12)), 5);
	} else process.stdout.write(message);
};
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	appendFileSync(join(cwd, ".mcp-log.jsonl"), `${JSON.stringify(message)}\n`);
	if (message.method === "initialize") {
		if (scenario.kind === "silent") return;
		if (scenario.kind === "exit") process.exit(2);
		if (scenario.kind === "initError") return send(1, undefined, { code: -32603, message: "init failed" });
		if (scenario.kind === "emptyInit") return send(1, {});
		return send(1, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } });
	}
	if (message.method === "tools/call") {
		setTimeout(() => {
			if (scenario.kind === "mcpError") return send(2, undefined, { code: -32603, message: "failed" });
			if (scenario.kind === "empty") return send(2, {});
			const text = scenario.kind === "textFailure" ? "index_codebase failed: fixture" : scenario.kind === "busy" ? "INDEX_BUSY: locked" : "Indexed 5 files";
			send(2, { content: [{ type: "text", text }], isError: scenario.kind === "isError", details: scenario.kind === "busyDetails" ? { code: "INDEX_BUSY" } : undefined });
		}, scenario.delay ?? 0);
	}
});
// Keep failure/timeout/cancellation scenarios alive even after stdin closes.
setInterval(() => {}, 1000);
