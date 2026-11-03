import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { configPaths, DEFAULT_CONFIG, envConfig, resolveConfig, saveConfigFile } from "../src/config.js";
import { harness, jsonFile, tempDirectory } from "./harness.js";

test("config: session > env > local > global > defaults, with per-key sources", (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const cwd = join(temp.root, "cwd"), env = { XDG_CONFIG_HOME: join(temp.root, "xdg"), PI_CODEBASE_ROUTER_MODE: "warn", PI_CODEBASE_AUTO_INDEX: "0" };
	const paths = configPaths(cwd, env);
	jsonFile(paths.global, { mode: "off", autoIndex: true, indexTimeoutMs: 123, unknown: [1] });
	jsonFile(paths.local, { mode: "enforce", autoIndexAfterWrite: true });
	const state = resolveConfig(cwd, true, { mode: "off" }, env);
	assert.equal(state.values.mode, "off"); assert.equal(state.sources.mode, "session");
	assert.equal(state.values.autoIndex, false); assert.equal(state.sources.autoIndex, "env");
	assert.equal(state.values.autoIndexAfterWrite, true); assert.equal(state.sources.autoIndexAfterWrite, "local");
	assert.equal(state.values.indexTimeoutMs, 123); assert.equal(state.sources.indexTimeoutMs, "global");
	assert.equal(state.values.worktreeMode, "off"); assert.equal(state.sources.worktreeMode, "default");
	assert.equal(resolveConfig(cwd, true, {}, env).values.mode, "warn");
});

test("config: strict file validation, tolerant loads and valid environment spellings", (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const env = { XDG_CONFIG_HOME: join(temp.root, "xdg") }, paths = configPaths(temp.root, env);
	jsonFile(paths.local, { mode: "invalid", autoIndex: "yes", indexTimeoutMs: 1.2, worktreeMode: "inherit" });
	const state = resolveConfig(temp.root, true, {}, env);
	assert.equal(state.values.mode, DEFAULT_CONFIG.mode); assert.match(state.layers.local.error!, /mode.*autoIndex.*indexTimeoutMs/);
	assert.equal(state.values.worktreeMode, "inherit");
	for (const raw of ["1", "TRUE", "yes", "on"]) assert.equal(envConfig({ PI_CODEBASE_AUTO_INDEX: raw }).autoIndex, true);
	for (const raw of ["0", "FALSE", "no", "off"]) assert.equal(envConfig({ PI_CODEBASE_AUTO_INDEX: raw }).autoIndex, false);
	assert.deepEqual(envConfig({ PI_CODEBASE_AUTO_INDEX: "invalid", PI_CODEBASE_INDEX_TIMEOUT_MS: "Infinity" }), {});
	for (const value of [0, -1, 0.1, Infinity, 2 ** 31]) assert.throws(() => saveConfigFile(paths.global, { indexTimeoutMs: value }), /Invalid/);
	assert.equal(existsSync(paths.global), false);
});

test("config: atomic merge/clear preserves unknown keys and rejects malformed/non-object saves", (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const path = join(temp.root, "nested", "router.json");
	jsonFile(path, { future: { answer: 42 }, mode: "warn", autoIndex: true });
	saveConfigFile(path, { mode: "off", autoIndex: null });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { future: { answer: 42 }, mode: "off" });
	assert.deepEqual(readdirSync(join(temp.root, "nested")), ["router.json"]);
	for (const text of ["{bad", "[]", "null", "false", '"string"']) {
		writeFileSync(path, text);
		assert.throws(() => saveConfigFile(path, { mode: "enforce" }));
		assert.equal(readFileSync(path, "utf8"), text);
	}
	jsonFile(path, { autoIndex: "bad" });
	assert.throws(() => saveConfigFile(path, { mode: "off" }), /autoIndex/);
	saveConfigFile(path, { autoIndex: null }); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
});

test("controller: command overrides persist on reload for same session, reset clears, forks do not inherit", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root, { env: { XDG_CONFIG_HOME: join(temp.root, "xdg"), PI_CODEBASE_ROUTER_MODE: "off" } });
	await h.emit("session_start", { reason: "startup" });
	await h.command("on"); assert.equal(h.controller.snapshot(h.ctx).effectiveMode, "enforce");
	await h.command("warn"); assert.equal(h.controller.snapshot(h.ctx).values.mode, "warn");
	await h.emit("session_shutdown", { reason: "reload" });
	await h.emit("session_start", { reason: "reload" });
	assert.equal(h.controller.snapshot(h.ctx).values.mode, "warn");
	const replacement = harness(join(temp.root, "replacement"), { env: h.options.env });
	replacement.entries.push(...h.entries);
	await replacement.emit("session_start", { reason: "reload" });
	assert.equal(replacement.controller.snapshot(replacement.ctx).values.mode, "warn");
	replacement.setSessionId("forked"); await replacement.emit("session_start", { reason: "fork" });
	assert.equal(replacement.controller.snapshot(replacement.ctx).values.mode, "off");
	await h.command("toggle"); assert.equal(h.controller.snapshot(h.ctx).values.mode, "off");
	await h.command("on"); await h.command("reset");
	assert.equal(h.controller.snapshot(h.ctx).values.mode, "off");
	assert.equal(h.controller.snapshot(h.ctx).sources.mode, "env");
	assert.ok(h.commandDefinition.getArgumentCompletions!("o"));
});

test("controller: persistent commands report shadowing; local/global resets only clear mode", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	await h.command("global warn"); assert.equal(h.controller.snapshot(h.ctx).values.mode, "warn");
	await h.command("local off"); assert.equal(h.controller.snapshot(h.ctx).values.mode, "off");
	await h.command("enforce"); await h.command("global off");
	assert.equal(h.controller.snapshot(h.ctx).values.mode, "enforce");
	assert.match(h.notifications.at(-1)!.text, /mode: "enforce" \[session\]/);
	await h.command("reset"); await h.command("local reset");
	assert.equal(h.controller.snapshot(h.ctx).values.mode, "off");
	await h.command("global reset"); assert.equal(h.controller.snapshot(h.ctx).sources.mode, "default");
	await h.command("status"); assert.match(h.notifications.at(-1)!.text, /worktreeMode/);
	await h.command("nonsense"); assert.equal(h.notifications.at(-1)!.type, "error");
});

test("controller: untrusted local config is ignored, saves rejected without creating files", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); h.setTrusted(false);
	const paths = configPaths(h.ctx.cwd, h.options.env);
	jsonFile(paths.global, { mode: "warn" });
	jsonFile(paths.local, { mode: "off", indexBin: "/untrusted/evil.js" });
	await h.emit("session_start", { reason: "startup" });
	let state = h.controller.snapshot(h.ctx);
	assert.equal(state.values.mode, "warn"); assert.equal(state.values.indexBin, undefined); assert.match(state.layers.local.ignored!, /not trusted/);
	assert.throws(() => h.controller.save(h.ctx, "local", { mode: "off" }), /not trusted/);
	const fresh = harness(join(temp.root, "fresh")); fresh.setTrusted(false);
	assert.throws(() => fresh.controller.save(fresh.ctx, "local", { mode: "off" }), /not trusted/);
	assert.equal(existsSync(join(fresh.ctx.cwd, ".codebase-index")), false);
	await h.command("off"); assert.equal(h.controller.snapshot(h.ctx).values.mode, "off");
	h.controller.save(h.ctx, "global", { mode: "enforce" });
	await h.command("reset"); state = h.controller.snapshot(h.ctx); assert.equal(state.values.mode, "enforce");
});

test("controller: save and append failures surface without publishing failed state", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	const paths = configPaths(h.ctx.cwd, h.options.env);
	jsonFile(paths.global, []); await h.command("global off");
	assert.equal(h.notifications.at(-1)!.type, "error"); assert.equal(h.controller.snapshot(h.ctx).values.mode, "enforce");
	writeFileSync(join(h.ctx.cwd, ".codebase-index"), "not a directory");
	await h.command("local off"); assert.equal(h.notifications.at(-1)!.type, "error");
	h.setAppendError(true); await h.command("off");
	assert.match(h.notifications.at(-1)!.text, /append failed/); assert.equal(h.controller.snapshot(h.ctx).values.mode, "enforce");
	// Deterministic filesystem failure even when tests run as root.
	const blocked = join(temp.root, "blocked"); mkdirSync(blocked);
	assert.throws(() => saveConfigFile(blocked, { mode: "off" }));
	h.ctx.hasUI = false;
	await assert.rejects(h.command("local off"));
});

test("controller: selected override clearing and branch reconstruction reveal lower layers", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = harness(temp.root); await h.emit("session_start", { reason: "startup" });
	h.controller.save(h.ctx, "global", { mode: "warn", autoIndexAfterWrite: false });
	h.controller.setSession(h.ctx, { mode: "off", autoIndexAfterWrite: true });
	h.controller.clearSession(h.ctx, ["mode"]);
	let state = h.controller.snapshot(h.ctx);
	assert.equal(state.values.mode, "warn"); assert.equal(state.sources.mode, "global");
	assert.equal(state.values.autoIndexAfterWrite, true); assert.equal(state.sources.autoIndexAfterWrite, "session");
	h.entries.pop(); await h.emit("session_tree");
	state = h.controller.snapshot(h.ctx); assert.equal(state.values.mode, "off");
	h.controller.save(h.ctx, "global", { autoIndexAfterWrite: null });
	h.controller.clearSession(h.ctx);
	state = h.controller.reload(h.ctx);
	assert.equal(state.values.autoIndexAfterWrite, false); assert.equal(state.sources.autoIndexAfterWrite, "default");
});
