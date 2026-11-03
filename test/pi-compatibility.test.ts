import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ToolCallEvent, ToolExecutionEndEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { readinessFailure } from "../src/results.js";
import { harness, tempDirectory, textResult, userStartEvent } from "./harness.js";

test("Pi compatibility: structured routing section preserves other extensions and prompt prefixes", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	const event = userStartEvent();
	const options = { ...event.systemPromptOptions, customPrompt: "user prefix", forceSystemPrompt: "another extension's override" };
	event.systemPromptOptions = options;
	options.sections.other_extension = "keep this section";
	options.promptGuidelines.push("keep this rule");
	assert.equal(await h.emit("before_agent_start", event), undefined, "must not return a full systemPrompt override");
	assert.match(options.sections.codebase_router, /Indexed-codebase routing/);
	assert.equal(event.systemPrompt, "base");
	assert.equal(options.customPrompt, "user prefix");
	assert.equal(options.forceSystemPrompt, "another extension's override");
	assert.equal(options.sections.other_extension, "keep this section");
	assert.deepEqual(options.promptGuidelines, ["keep this rule"]);
	const guidance = options.sections.codebase_router;
	await h.emit("before_agent_start", event);
	assert.equal(options.sections.codebase_router, guidance, "repeated calls replace one section, not append duplicate guidance");
	await h.command("off"); await h.emit("before_agent_start", event);
	assert.equal(options.sections.codebase_router, undefined);
	assert.equal(options.sections.other_extension, "keep this section");
	await h.command("on"); await h.emit("before_agent_start", event);
	assert.equal(options.sections.codebase_router, guidance);
});

test("Pi compatibility: custom-message and non-code starts remove stale router sections without requiring prompt", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	const event = userStartEvent(); await h.emit("before_agent_start", event);
	const custom = {
		type: "before_agent_start", messageType: "custom", systemPrompt: "base", systemPromptOptions: event.systemPromptOptions,
		message: { role: "custom", customType: "fixture", content: "fix source", display: false, timestamp: 0 },
	};
	assert.equal("prompt" in custom, false);
	assert.equal(await h.emit("before_agent_start", custom), undefined);
	assert.equal(custom.systemPromptOptions.sections.codebase_router, undefined);
	await h.emit("before_agent_start", event);
	event.prompt = "hello"; await h.emit("before_agent_start", event);
	assert.equal(event.systemPromptOptions.sections.codebase_router, undefined);
	event.prompt = "fix source"; await h.emit("before_agent_start", event);
	h.setTools(["read", "edit", "write", "bash"]); await h.emit("before_agent_start", event);
	assert.equal(event.systemPromptOptions.sections.codebase_router, undefined);
});

test("Pi compatibility: nested tool results finalize by child ID with no execution-end arguments; only agent_settled schedules", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.controller.setSession(h.ctx, { autoIndexAfterWrite: true, autoIndexViaTurn: true });
	const parentToolCallId = "codemode-parent";
	for (const [n, path] of [[1, "inside.ts"], [2, "../outside.ts"], [3, "failed.ts"]] as const) {
		const event: ToolCallEvent = { type: "tool_call", toolName: "write", toolCallId: `${parentToolCallId}/${n}`, parentToolCallId, input: { path, content: "fixture" } };
		await h.emit("tool_call", event);
	}
	async function finish(n: number, path: string, isError: boolean) {
		const resultEvent: ToolResultEvent = {
			type: "tool_result", toolName: "write", toolCallId: `${parentToolCallId}/${n}`, parentToolCallId,
			input: { path, content: "fixture" }, content: [{ type: "text", text: isError ? "write failed" : "ok" }], details: undefined, isError,
		};
		await h.emit("tool_result", resultEvent);
		assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false, "tool_result is not the finalized execution event");
		const endEvent: ToolExecutionEndEvent = {
			type: "tool_execution_end", toolName: "write", toolCallId: resultEvent.toolCallId, parentToolCallId,
			result: { content: resultEvent.content, details: resultEvent.details }, isError: resultEvent.isError, durationMs: 1,
		};
		assert.equal("args" in endEvent, false); assert.equal("input" in endEvent, false);
		await h.emit("tool_execution_end", endEvent);
	}
	await finish(3, "failed.ts", true); assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	await finish(2, "../outside.ts", false); assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	await finish(1, "inside.ts", false); assert.equal(h.controller.snapshot(h.ctx).pendingMutation, true);
	await h.emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(h.messages.length, 0, "agent_end may precede retries/continuations");
	await h.emit("agent_settled", { type: "agent_settled", aborted: true });
	assert.equal(h.messages.length, 1, "successful writes still persist when the run later aborts");
});

test("Pi compatibility: native status details and real-companion MCP text-only status both degrade correctly", () => {
	const text = "Active branch catalog state: legacy\nActive branch catalog chunks: 0\nActive branch catalog registered: no\nStorage migrations: none pending\nCodebase is not indexed. Run index_codebase to create an index.";
	const mcp = { ...textResult(text), structuredContent: { mcpDiagnostics: {} } };
	assert.ok(readinessFailure(mcp), "MCP does not provide the native Pi details status");
	assert.equal(readinessFailure(textResult("Storage migrations: none pending", { indexed: true, migrationRequired: false, compatibility: { compatible: true } })), undefined);
	assert.ok(readinessFailure(textResult("Storage migrations: pending")));
	assert.ok(readinessFailure({ ...textResult("failed retrieval"), isError: true, structuredContent: [] }));
});

test("Pi compatibility: runtime minimum and shipped version-matched package changelog satisfy Pi 1.5", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.engines.node, ">=22.19.0");
	const changelogPath = (pkg.pi.changelogPath ?? "CHANGELOG.md").replace(/^\.\//, "");
	assert.equal(changelogPath, "CHANGELOG.md");
	assert.ok(pkg.files.includes(changelogPath), "Pi update notices require the changelog to ship in the package");
	const changelog = readFileSync(new URL(`../${changelogPath}`, import.meta.url), "utf8");
	const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	assert.match(changelog, new RegExp(`^## (?:\\[${escapedVersion}\\]|${escapedVersion})(?:\\s|$)`, "m"), "release version must have a matching heading; convert Unreleased when the parent bumps to 0.4.0");
});
