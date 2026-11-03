import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BackgroundIndexer, resolveIndexLauncher, type IndexOutcome } from "../src/background.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { fixtureBin, fixtureLog, harness, jsonFile, tempDirectory, textResult, waitFor } from "./harness.js";

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function indexCalls(cwd: string): number { return fixtureLog(cwd).filter((entry) => entry.method === "tools/call").length; }

test("background: newline JSON-RPC handshake, scoped Pi host, explicit incremental force:false", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	jsonFile(join(temp.root, ".mcp-scenario.json"), { kind: "normal", split: true });
	const background = new BackgroundIndexer(); t.after(() => background.cancel());
	let outcome: IndexOutcome | undefined;
	background.start(temp.root, { command: process.execPath, args: [fixtureBin] }, 3000, (result) => { outcome = result; });
	await waitFor(() => Boolean(outcome), "successful index");
	assert.equal(outcome!.success, true); assert.equal(background.running, false);
	const log = fixtureLog(temp.root);
	assert.deepEqual(log[0].argv, ["--project", temp.root, "--host", "pi"]);
	assert.deepEqual(log.filter((item) => item.method).map((item) => item.method), ["initialize", "notifications/initialized", "tools/call"]);
	assert.deepEqual(log.find((item) => item.method === "tools/call").params, { name: "index_codebase", arguments: { force: false } });
	assert.equal(alive(log[0].pid), false);
});

for (const kind of ["initError", "emptyInit", "mcpError", "isError", "textFailure", "busy", "busyDetails", "empty", "exit", "silent"]) {
	test(`background: ${kind} is not success and cleans process/timer state`, async (t) => {
		const temp = tempDirectory(); t.after(temp.cleanup);
		jsonFile(join(temp.root, ".mcp-scenario.json"), { kind });
		const background = new BackgroundIndexer(); t.after(() => background.cancel());
		let outcome: IndexOutcome | undefined, completions = 0;
		background.start(temp.root, { command: process.execPath, args: [fixtureBin] }, kind === "silent" ? 500 : 3000, (result) => { outcome = result; completions++; });
		await waitFor(() => Boolean(outcome), kind);
		assert.equal(outcome!.success, false); assert.equal(background.running, false); assert.equal(completions, 1);
		const pid = Number(readFileSync(join(temp.root, ".mcp-pid"), "utf8")); assert.equal(alive(pid), false);
		if (kind === "initError" || kind === "emptyInit") assert.equal(indexCalls(temp.root), 0);
	});
}

test("background: spawn failure completes once without an agent-turn fallback", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const background = new BackgroundIndexer(); t.after(() => background.cancel());
	let outcome: IndexOutcome | undefined, completions = 0;
	background.start(temp.root, { command: join(temp.root, "not-an-executable"), args: [] }, 1000, (result) => { outcome = result; completions++; });
	await waitFor(() => Boolean(outcome)); await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(outcome!.success, false); assert.equal(background.running, false); assert.equal(completions, 1);
	assert.equal(resolveIndexLauncher(temp.root, { ...DEFAULT_CONFIG, indexBin: "/missing" }, temp.root, ".pi"), undefined);
});

test("background: cancel suppresses stale callbacks and escalates SIGTERM-resistant children", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	jsonFile(join(temp.root, ".mcp-scenario.json"), { kind: "normal", delay: 5000, ignoreTerm: true });
	const background = new BackgroundIndexer(); t.after(() => background.cancel());
	let completions = 0;
	background.start(temp.root, { command: process.execPath, args: [fixtureBin] }, 3000, () => { completions++; });
	await waitFor(() => indexCalls(temp.root) === 1);
	const pid = Number(readFileSync(join(temp.root, ".mcp-pid"), "utf8"));
	background.cancel(); background.cancel(); assert.equal(background.running, false);
	await waitFor(() => !alive(pid), "canceled process exits"); assert.equal(completions, 0);
});

test("controller background: coalesces successful scoped writes during a run into one rerun", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); t.after(() => h.emit("session_shutdown", { reason: "quit" }));
	jsonFile(join(h.ctx.cwd, ".mcp-scenario.json"), { kind: "normal", delay: 150 });
	await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true, indexBin: fixtureBin });
	async function write(id: string) {
		await h.emit("tool_call", { toolName: "write", toolCallId: id, input: { path: `${id}.ts` } });
		await h.emit("tool_execution_end", { toolName: "write", toolCallId: id, isError: false, result: textResult("ok") });
		await h.emit("agent_settled");
	}
	await write("first"); await waitFor(() => indexCalls(h.ctx.cwd) === 1);
	await write("second"); await write("third");
	await waitFor(() => indexCalls(h.ctx.cwd) === 2, "coalesced rerun");
	await waitFor(() => !h.controller.snapshot(h.ctx).indexing, "rerun completion");
	assert.equal(indexCalls(h.ctx.cwd), 2); assert.equal(h.messages.length, 0);
});

for (const stop of ["off", "shutdown"] as const) {
	test(`controller background: ${stop} cancels active/pending work without stale status or rerun`, async (t) => {
		const temp = tempDirectory(); t.after(temp.cleanup);
		const h = harness(temp.root); t.after(() => h.emit("session_shutdown", { reason: "quit" }));
		jsonFile(join(h.ctx.cwd, ".mcp-scenario.json"), { kind: "normal", delay: 500 });
		const local = join(h.ctx.cwd, ".codebase-index", "router.json");
		jsonFile(local, { autoIndex: true, autoIndexAfterWrite: true, indexBin: fixtureBin });
		await h.emit("session_start", { reason: "startup" }); await waitFor(() => indexCalls(h.ctx.cwd) === 1);
		await h.emit("tool_call", { toolName: "write", toolCallId: "write", input: { path: "new.ts" } });
		await h.emit("tool_execution_end", { toolName: "write", toolCallId: "write", isError: false, result: textResult("ok") });
		await h.emit("agent_settled");
		if (stop === "off") await h.command("off"); else await h.emit("session_shutdown", { reason: "quit" });
		const statusLength = h.statuses.length;
		const pid = Number(readFileSync(join(h.ctx.cwd, ".mcp-pid"), "utf8"));
		await waitFor(() => !alive(pid)); await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(h.statuses.length, statusLength); assert.equal(indexCalls(h.ctx.cwd), 1);
		assert.equal(h.controller.snapshot(h.ctx).indexing, false); assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	});
}

test("controller background: failed index drops dirty rerun and never reports current", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); t.after(() => h.emit("session_shutdown", { reason: "quit" }));
	jsonFile(join(h.ctx.cwd, ".mcp-scenario.json"), { kind: "textFailure", delay: 100 });
	jsonFile(join(h.ctx.cwd, ".codebase-index", "router.json"), { autoIndex: true, autoIndexAfterWrite: true, indexBin: fixtureBin });
	await h.emit("session_start", { reason: "startup" }); await waitFor(() => indexCalls(h.ctx.cwd) === 1);
	await h.emit("tool_call", { toolName: "write", toolCallId: "write", input: { path: "new.ts" } });
	await h.emit("tool_execution_end", { toolName: "write", toolCallId: "write", isError: false, result: textResult("ok") }); await h.emit("agent_settled");
	await waitFor(() => !h.controller.snapshot(h.ctx).indexing);
	assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
	assert.equal(indexCalls(h.ctx.cwd), 1); assert.doesNotMatch(h.statuses.at(-1)!, /current|refreshed/);
	assert.equal(h.messages.length, 0);
});

test("controller background: off skips session and after-write auto-index", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); t.after(() => h.emit("session_shutdown", { reason: "quit" }));
	jsonFile(join(h.ctx.cwd, ".codebase-index", "router.json"), { mode: "off", autoIndex: true, autoIndexAfterWrite: true, indexBin: fixtureBin });
	await h.emit("session_start", { reason: "startup" });
	await h.emit("tool_call", { toolName: "write", toolCallId: "write", input: { path: "new.ts" } });
	await h.emit("tool_execution_end", { toolName: "write", toolCallId: "write", result: textResult("ok"), isError: false });
	await h.emit("agent_settled");
	assert.equal(existsSync(join(h.ctx.cwd, ".mcp-pid")), false);
});

test("background: project-local launchers require trust; explicit missing paths do not fall through", (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const agentDir = join(temp.root, "agent");
	const localBin = join(temp.root, ".pi", "npm", "node_modules", "opencode-codebase-index", "dist", "cli.js");
	jsonFile(localBin, {});
	assert.equal(resolveIndexLauncher(temp.root, DEFAULT_CONFIG, agentDir, ".pi", false), undefined);
	assert.equal(resolveIndexLauncher(temp.root, DEFAULT_CONFIG, agentDir, ".pi", true)!.args[0], localBin);
	const globalBin = join(agentDir, "npm", "node_modules", "opencode-codebase-index", "dist", "cli.js");
	jsonFile(globalBin, {});
	assert.equal(resolveIndexLauncher(temp.root, DEFAULT_CONFIG, agentDir, ".pi", false)!.args[0], globalBin);
	assert.equal(resolveIndexLauncher(temp.root, { ...DEFAULT_CONFIG, indexBin: "missing.js" }, agentDir, ".pi", true), undefined);
});
