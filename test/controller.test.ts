import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { harness, tempDirectory, textResult, userStartEvent } from "./harness.js";

const call = (toolName: string, input: unknown, toolCallId = "call") => ({ toolName, input, toolCallId });
const end = (toolName: string, toolCallId = "call", result = textResult("ok"), isError = false) => ({ toolName, toolCallId, result, isError });

test("controller: off/on/warn guards and built-in read/edit/write always allowed", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	for (const tool of ["read", "edit", "write"]) assert.equal(await h.emit("tool_call", call(tool, { path: "src/file.ts" })), undefined);
	assert.equal((await h.emit("tool_call", call("grep", { pattern: "where is behavior" }))).block, true);
	await h.command("warn"); assert.equal(await h.emit("tool_call", call("bash", { command: "cat src/file.ts" })), undefined);
	assert.match(h.statuses.at(-1)!, /warn only/);
	await h.command("off"); assert.equal(await h.emit("tool_call", call("grep", { pattern: "where is behavior" })), undefined);
	assert.equal(await h.emit("before_agent_start", userStartEvent()), undefined);
	await h.command("on"); assert.equal((await h.emit("tool_call", call("bash", { command: "cat src/file.ts" }))).block, true);
});

test("controller: optional orientation guidance, no mandatory chain, custom messages without prompt", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	const custom = { messageType: "custom", message: { content: "fix the code" }, systemPrompt: "base", systemPromptOptions: { sections: {} } };
	assert.equal(await h.emit("before_agent_start", custom), undefined);
	const event = userStartEvent("fix the code");
	assert.equal(await h.emit("before_agent_start", event), undefined);
	const guidance = event.systemPromptOptions.sections.codebase_router;
	assert.match(guidance, /index_status/); assert.match(guidance, /tokenBudget: 600, limit: 5/);
	assert.match(guidance, /implementation_lookup directly/); assert.match(guidance, /codebase_edit_context/);
	assert.doesNotMatch(guidance, /use codebase_peek first/);
	assert.equal(await h.emit("before_agent_start", userStartEvent("hello")), undefined);
	for (const name of ["codebase_context", "codebase_edit_context", "architecture_context", "implementation_lookup"]) {
		await h.emit("tool_execution_end", end(name));
	}
	assert.deepEqual(h.controller.snapshot(h.ctx).counters, { blocked: 0, indexedCalls: 4, context: 1, editContext: 1, architecture: 1 });
});

test("controller: missing tools and observed readiness/retrieval failures degrade rather than trap", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.setTools(["read", "write", "edit", "bash", "grep"]);
	assert.equal(await h.emit("tool_call", call("grep", { pattern: "where is behavior" })), undefined);
	assert.equal(await h.emit("before_agent_start", userStartEvent()), undefined);
	h.setTools(["index_status", "codebase_context", "bash", "grep"]);
	assert.equal(await h.emit("tool_call", call("bash", { command: "cat file.ts" })), undefined, "no read replacement");
	assert.equal(await h.emit("tool_call", call("bash", { command: "echo text > file.ts" })), undefined, "no write replacement");
	for (const result of [
		textResult("Not indexed", { indexed: false }),
		textResult("Index incompatible", { indexed: true, compatibility: { compatible: false } }),
		textResult("Storage migration required", { indexed: true, migrationRequired: true }),
		textResult("no chunks", { indexed: true, branchReadiness: { state: "empty" } }),
	]) {
		await h.emit("tool_execution_end", end("index_status", "status", result));
		assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
		assert.equal(await h.emit("tool_call", call("grep", { pattern: "where is behavior" })), undefined);
		const event = userStartEvent();
		await h.emit("before_agent_start", event);
		assert.match(event.systemPromptOptions.sections.codebase_router, /fallback are allowed/);
		await h.emit("tool_execution_end", end("index_status", "status", textResult("Indexed", { indexed: true, compatibility: { compatible: true } })));
		assert.equal(h.controller.snapshot(h.ctx).readiness, "ready");
	}
	await h.emit("tool_execution_end", end("codebase_context", "retrieval", textResult("Model mismatch: stored embeddings differ"), true));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
	assert.equal(await h.emit("tool_call", call("grep", { pattern: "where is behavior" })), undefined);
});

test("controller: index errors/busy/text failures never mark current; estimates do not mark current", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	for (const result of [textResult("index_codebase failed: fixture"), textResult("locked", { code: "INDEX_BUSY" }), { ...textResult("oops"), isError: true }]) {
		await h.emit("tool_call", call("index_codebase", {}));
		await h.emit("tool_execution_end", end("index_codebase", "call", result));
		assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
		assert.doesNotMatch(h.statuses.at(-1)!, /current|refreshed/);
	}
	await h.emit("tool_call", call("index_codebase", { estimateOnly: true }));
	await h.emit("tool_execution_end", end("index_codebase", "call", textResult("Estimated cost")));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
	await h.emit("tool_call", call("index_codebase", { force: false }));
	await h.emit("tool_execution_end", end("index_codebase"));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "ready");
});

test("controller: capture input by toolCallId; only successful scoped writes dirty", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true, autoIndexViaTurn: true });
	const outside = join(temp.root, "outside"); mkdirSync(outside); symlinkSync(outside, join(h.ctx.cwd, "external"));
	for (const [id, path, failed] of [["outside", "../outside/new.ts", false], ["symlink", "external/nested/new.ts", false], ["failed", "src/bad.ts", true], ["blocked", "src/block.ts", true]] as const) {
		await h.emit("tool_call", call("write", { path }, id));
		await h.emit("tool_execution_end", end("write", id, textResult(failed ? "blocked/failed" : "ok"), failed));
		assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false, id);
	}
	await h.emit("tool_execution_end", end("edit", "unknown"));
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	// Parallel completion order differs from source order and end events have no args.
	await h.emit("tool_call", call("write", { path: "src/new.ts" }, "inside"));
	await h.emit("tool_call", call("edit", { path: "../outside/file.ts" }, "outside2"));
	await h.emit("tool_execution_end", end("edit", "outside2"));
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	await h.emit("tool_execution_end", end("write", "inside"));
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, true);
	await h.emit("agent_settled"); assert.equal(h.messages.length, 1);
	await h.emit("agent_settled"); assert.equal(h.messages.length, 1);
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
});

test("controller: pending writes are canceled by off and shutdown; no surprise CLI fallback turn/install", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true, indexBin: join(temp.root, "missing.js") });
	await h.emit("tool_call", call("write", { path: "new.ts" }));
	await h.emit("tool_execution_end", end("write"));
	await h.command("off"); await h.command("on"); await h.emit("agent_settled");
	assert.equal(h.messages.length, 0); assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	await h.emit("tool_call", call("write", { path: "new.ts" })); await h.emit("tool_execution_end", end("write"));
	await h.emit("agent_settled"); assert.equal(h.messages.length, 0); assert.match(h.statuses.at(-1)!, /no automatic turn\/install/);
	await h.emit("tool_call", call("write", { path: "other.ts" }));
	await h.emit("session_shutdown", { reason: "quit" });
	await h.emit("tool_execution_end", end("write")); await h.emit("agent_settled");
	assert.equal(h.statuses.at(-1), undefined); assert.equal(h.messages.length, 0);
});

test("controller: optional settings integration receives the live typed controller even while off", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	let opened = 0;
	const h = harness(temp.root, { async openSettings(controller, ctx) { opened++; controller.setSession(ctx, { mode: "off" }); } });
	await h.emit("session_start", { reason: "startup" }); await h.command(""); await h.command("settings");
	assert.equal(opened, 2); assert.equal(h.controller.snapshot(h.ctx).values.mode, "off");
});

test("controller: inactive/hidden tools degrade, codemode/deferred tools stay available", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.setActiveTools(["read", "bash", "grep"]);
	assert.equal(h.controller.snapshot(h.ctx).available, false);
	assert.equal(await h.emit("tool_call", call("grep", { pattern: "where is behavior" })), undefined);
	h.setExposures({ index_status: "codemode", codebase_context: "deferred" });
	assert.equal(h.controller.snapshot(h.ctx).available, true);
	h.setExposures({ index_status: "hidden", codebase_context: "deferred" });
	assert.equal(h.controller.snapshot(h.ctx).available, false);
});

test("controller: off cancels captured calls even if they finalize after on", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	await h.emit("tool_call", call("index_codebase", {}, "index"));
	await h.emit("tool_call", call("codebase_context", {}, "context"));
	await h.command("off"); await h.command("on");
	const statusLength = h.statuses.length;
	await h.emit("tool_execution_end", end("index_codebase", "index", textResult("index_codebase failed: stale")));
	await h.emit("tool_execution_end", end("codebase_context", "context"));
	assert.equal(h.statuses.length, statusLength);
	assert.equal(h.controller.snapshot(h.ctx).readiness, "unknown");
	assert.equal(h.controller.snapshot(h.ctx).counters.indexedCalls, 0);
});

test("controller: off warns only for an actually queued opt-in agent turn, schedules no more", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	await h.command("off"); assert.doesNotMatch(h.notifications.at(-1)!.text, /cannot be retracted/);
	await h.command("on"); h.controller.setSession(h.ctx, { autoIndexAfterWrite: true, autoIndexViaTurn: true });
	await h.emit("tool_call", call("write", { path: "new.ts" })); await h.emit("tool_execution_end", end("write"));
	await h.emit("agent_settled"); assert.equal(h.messages.length, 1);
	assert.equal(h.controller.snapshot(h.ctx).queuedTurn, true);
	await h.command("off"); assert.match(h.notifications.at(-1)!.text, /cannot be retracted/);
	await h.emit("agent_settled"); assert.equal(h.messages.length, 1);
	assert.equal(h.controller.snapshot(h.ctx).queuedTurn, false);
	await h.emit("tool_execution_end", end("index_codebase"));
	assert.equal(h.controller.snapshot(h.ctx).turnMayStillRun, false);
});

test("controller: partial embedding failures and empty results never mark an index current", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	for (const result of [textResult("warning", { failedChunks: 2 }), textResult("warning", { failedBatchesCount: 1 }), textResult("reset", { resetCorruptedIndex: true }), { content: [] }]) {
		await h.emit("tool_call", call("index_codebase", {}));
		await h.emit("tool_execution_end", { toolName: "index_codebase", toolCallId: "call", result, isError: false });
		assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
		assert.doesNotMatch(h.statuses.at(-1)!, /current|refreshed/);
	}
});

test("controller: later tool-call input mutations cannot dirty outside paths", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true });
	const input = { path: "inside.ts" };
	await h.emit("tool_call", call("write", input, "rewritten"));
	input.path = "../outside.ts"; // A later host handler mutates the same input object.
	await h.emit("tool_execution_end", end("write", "rewritten"));
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	await h.emit("tool_execution_end", end("codebase_context", "failed-text", textResult("retrieval unavailable", { code: "INDEX_NOT_READY" })));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
});
