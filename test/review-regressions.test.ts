import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { saveConfigFile } from "../src/config.js";
import { INDEX_TOOLS, classifyBash, classifyGrep } from "../src/routing.js";
import { inspectProject, isScopedPath } from "../src/scope.js";
import { readinessFailure, retrievalReadinessFailure, statusIsReady } from "../src/results.js";
import { harness, jsonFile, tempDirectory, textResult, userStartEvent } from "./harness.js";

const end = (toolName: string, result: unknown, isError = false, toolCallId = "call") => ({ toolName, toolCallId, result, isError });
const call = (toolName: string, input: unknown, toolCallId = "call") => ({ toolName, input, toolCallId });

test("review: arbitrary source snippets never determine readiness or enter the system prompt", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	const source = 'catch (error: unknown) { return "migration required; index missing; INDEX_BUSY; codebase_context failed:"; }\n' + "untrusted source ".repeat(1000);
	for (const name of INDEX_TOOLS) {
		await h.emit("tool_execution_end", end(name, textResult(source)));
		assert.equal(h.controller.snapshot(h.ctx).readiness, "unknown", name);
		assert.equal(h.controller.snapshot(h.ctx).issue, undefined, name);
	}
	const event = userStartEvent(); await h.emit("before_agent_start", event);
	assert.doesNotMatch(event.systemPromptOptions.sections.codebase_router, /untrusted source|Index unavailable/);
	assert.equal((await h.emit("tool_call", call("grep", { pattern: "conceptual search" }))).block, true);
});

test("review: query errors are transient; index-specific errors degrade and healthy text-only MCP status recovers", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	await h.emit("tool_execution_end", end("index_status", textResult("Indexed", { indexed: true })));
	await h.emit("tool_execution_end", end("codebase_search", textResult("invalid filter"), true));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "ready");
	assert.match(h.statuses.at(-1)!, /query failed/);
	await h.emit("tool_execution_end", end("codebase_search", textResult("Model mismatch: " + "unsafe text ".repeat(1000)), true));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
	assert.ok(h.controller.snapshot(h.ctx).issue!.length < 100);
	const event = userStartEvent(); await h.emit("before_agent_start", event);
	assert.doesNotMatch(event.systemPromptOptions.sections.codebase_router, /unsafe text/);
	assert.ok(event.systemPromptOptions.sections.codebase_router.length < 250);
	await h.emit("tool_execution_end", end("index_status", textResult("Indexed chunks (all branches): 10\nActive branch catalog state: ready\nStorage migrations: none pending\nCompatibility: Index is compatible with the current provider and model.")));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "ready");
	assert.equal(h.controller.snapshot(h.ctx).issue, undefined);
	await h.emit("tool_execution_end", end("codebase_context", textResult("busy", { code: "INDEX_BUSY" })));
	assert.equal(h.controller.snapshot(h.ctx).readiness, "degraded");
});

test("review: operational failures remain bounded and recognize current companion compatibility warnings", () => {
	assert.equal(readinessFailure(textResult("index_codebase failed: " + "data".repeat(5000))), "index operation failed; check index_status");
	assert.equal(readinessFailure(textResult("COMPATIBILITY WARNING: Model mismatch: old model")), "index incompatible");
	assert.ok(readinessFailure(textResult("Storage migrations: pending")));
});

test("review: current companion retrieval errors and structural/legacy MCP status formats are supported", () => {
	for (const text of [
		"The existing index is incompatible with the configured embedding provider.",
		"The existing index requires a storage migration.",
		"The existing index has failed embedding batches.",
		"The existing index is unreadable.",
		"Automatic indexing failed at an earlier time.", "Automatic indexing stopped before a readable index was ready.",
		"Automatic indexing is waiting.", "Path storage format mismatch: old layout", "Embedding strategy mismatch: old strategy",
	]) {
		assert.ok(retrievalReadinessFailure(textResult(text), true), text);
		assert.equal(retrievalReadinessFailure(textResult(text)), undefined, "successful source is never an error signal");
	}
	for (const text of [
		"Stored chunks (structural, all branches): 1,234\nActive branch catalog state: ready\nCompatibility: Structural index; no embedding provider required.",
		"Indexed chunks: 12\nCompatibility: Index is compatible with the current provider and model.",
		"Stored chunks (structural, all branches): 12\nCompatibility: Structural index; no embedding provider required.",
	]) assert.equal(statusIsReady(textResult(text)), true, text);
	assert.equal(statusIsReady(textResult("Indexed chunks: 12\nActive branch catalog state: missing\nCompatibility: Index is compatible")), false);
	assert.equal(statusIsReady(textResult("Indexed chunks: 0\nCompatibility: Index is compatible")), false);
});

test("review: edit diffs containing error declarations still count as successful mutations", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true });
	await h.emit("tool_call", call("edit", { path: "source.ts" }));
	await h.emit("tool_execution_end", end("edit", textResult('+ catch (error: unknown) { return "index missing"; }')));
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, true);
});

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-c", "user.name=Router Test", "-c", "user.email=router@example.invalid", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
test("review: nested linked worktrees bypass main-checkout guards and mutation indexing, even without Git on PATH", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root), main = h.ctx.cwd;
	git(main, "init", "-q"); git(main, "add", "."); git(main, "commit", "-qm", "fixture");
	const worktree = join(main, ".worktrees", "feature");
	git(main, "worktree", "add", "--detach", worktree, "HEAD");
	mkdirSync(join(worktree, "nested"));
	symlinkSync(worktree, join(main, "worktree-alias"), "dir");
	assert.equal(isScopedPath(main, join(worktree, "new/file.ts")), false);
	assert.equal(isScopedPath(main, "worktree-alias/new.ts"), false);
	assert.equal(classifyGrep(main, { pattern: "conceptual search", path: worktree }), undefined);
	assert.equal(classifyBash(main, `cat '${join(worktree, "new.ts")}'`), undefined);
	await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true });
	await h.emit("tool_call", call("write", { path: join(worktree, "new.ts") }));
	await h.emit("tool_execution_end", end("write", textResult("ok")));
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	const oldPath = process.env.PATH;
	try {
		process.env.PATH = "";
		assert.equal(inspectProject(join(worktree, "nested")).linkedWorktree, true);
		assert.equal(inspectProject(main).linkedWorktree, false);
	} finally { process.env.PATH = oldPath; }
});

test("review: settings saves preserve dotfile symlinks, unknown keys and existing permissions", (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const target = join(temp.root, "dotfiles", "router.json"), link = join(temp.root, "router.json");
	jsonFile(target, { mode: "warn", future: 1 }); chmodSync(target, 0o664);
	symlinkSync(target, link);
	saveConfigFile(link, { mode: "off" });
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(readlinkSync(link), target);
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { mode: "off", future: 1 });
	assert.equal(statSync(target).mode & 0o777, 0o664);
	writeFileSync(target, "{bad");
	assert.throws(() => saveConfigFile(link, { mode: "enforce" }));
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(readFileSync(target, "utf8"), "{bad");
	const missing = join(temp.root, "future", "router.json"), dangling = join(temp.root, "dangling.json");
	symlinkSync(missing, dangling);
	saveConfigFile(dangling, { mode: "off" });
	assert.equal(lstatSync(dangling).isSymbolicLink(), true);
	assert.deepEqual(JSON.parse(readFileSync(missing, "utf8")), { mode: "off" });
});

test("review: consumed or aborted legacy follow-ups do not prevent subsequent indexing requests", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true, autoIndexViaTurn: true });
	async function edit() {
		await h.emit("tool_call", call("write", { path: "new.ts" }));
		await h.emit("tool_execution_end", end("write", textResult("ok")));
		await h.emit("agent_settled");
	}
	await edit(); assert.equal(h.messages.length, 1);
	await h.emit("before_agent_start", userStartEvent("refresh index"));
	await h.emit("agent_settled", { aborted: true });
	assert.equal(h.controller.snapshot(h.ctx).queuedTurn, false);
	await edit(); assert.equal(h.messages.length, 2);
});

test("review: print commands have text output and JSON commands emit structured custom messages without model turns", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	const ctx = h.ctx as unknown as { hasUI: boolean; mode: string };
	ctx.hasUI = false; ctx.mode = "print";
	const output: string[] = [];
	t.mock.method(console, "log", (text: string) => output.push(text));
	await h.command("off");
	assert.match(output.at(-1)!, /Router effective mode: off/);
	ctx.mode = "json";
	await h.command("status");
	const message = h.messages.at(-1) as { message: { customType: string; content: string }; options: { triggerTurn: boolean } };
	assert.equal(message.message.customType, "codebase-router:status");
	assert.match(message.message.content, /Router effective mode: off/);
	assert.equal(message.options.triggerTurn, false);
});
