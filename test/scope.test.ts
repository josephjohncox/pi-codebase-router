import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { classifyBash, classifyGrep } from "../src/routing.js";
import { inspectProject, isScopedPath } from "../src/scope.js";
import { fixtureBin, harness, tempDirectory, textResult, userStartEvent } from "./harness.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=Router Test", "-c", "user.email=router@example.invalid", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function initRepository(cwd: string): void {
	mkdirSync(cwd, { recursive: true }); git(cwd, "init", "-q");
	writeFileSync(join(cwd, "source.ts"), "export const fixture = 1;\n");
	git(cwd, "add", "."); git(cwd, "commit", "-qm", "test fixture");
}

test("scope: canonical containment covers symlinks and existing parents of new files", (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const cwd = join(temp.root, "repo"), outside = join(temp.root, "outside");
	mkdirSync(cwd); mkdirSync(outside);
	writeFileSync(join(cwd, "inside.ts"), ""); writeFileSync(join(outside, "outside.ts"), "");
	symlinkSync(outside, join(cwd, "external"), "dir"); symlinkSync(cwd, join(temp.root, "alias"), "dir");
	symlinkSync(join(outside, "outside.ts"), join(cwd, "external-file.ts"));
	symlinkSync(join(outside, "not-yet-created.ts"), join(cwd, "dangling.ts"));
	symlinkSync("loop.ts", join(cwd, "loop.ts"));
	assert.equal(isScopedPath(cwd, "inside.ts"), true);
	assert.equal(isScopedPath(cwd, "new/nested/file.ts"), true);
	assert.equal(isScopedPath(cwd, "external/new/nested/file.ts"), false);
	assert.equal(isScopedPath(cwd, "external-file.ts"), false);
	assert.equal(isScopedPath(cwd, "dangling.ts"), false);
	assert.equal(isScopedPath(cwd, "loop.ts"), false);
	assert.equal(isScopedPath(join(temp.root, "alias"), join(cwd, "new.ts")), true);
	assert.equal(isScopedPath(cwd, "@inside.ts"), true);
	assert.equal(isScopedPath(cwd, "../outside/outside.ts"), false);
	assert.equal(isScopedPath(cwd, `${cwd}-sibling/foo.ts`), false);
	assert.equal(isScopedPath(cwd, undefined), false);
});

test("scope: linked worktrees including nested cwd bypass by default; submodules do not", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const main = join(temp.root, "main"), worktree = join(temp.root, "sibling"), source = join(temp.root, "module-source");
	initRepository(main); initRepository(source);
	git(main, "worktree", "add", "--detach", worktree, "HEAD");
	mkdirSync(join(worktree, "nested"));
	git(main, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
	assert.equal(inspectProject(main).linkedWorktree, false);
	assert.equal(inspectProject(worktree).linkedWorktree, true);
	assert.equal(inspectProject(join(worktree, "nested")).linkedWorktree, true);
	assert.equal(inspectProject(join(main, "module")).linkedWorktree, false);
	const h = harness(join(temp.root, "harness")); h.ctx.cwd = join(worktree, "nested");
	h.controller.setSession(h.ctx, { autoIndex: true, autoIndexAfterWrite: true, indexBin: fixtureBin });
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.controller.snapshot(h.ctx).effectiveMode, "off");
	assert.equal(await h.emit("before_agent_start", userStartEvent()), undefined);
	assert.equal(await h.emit("tool_call", { toolName: "bash", toolCallId: "read", input: { command: "cat local.ts" } }), undefined);
	await h.emit("tool_call", { toolName: "write", toolCallId: "write", input: { path: "new.ts" } });
	await h.emit("tool_execution_end", { toolName: "write", toolCallId: "write", isError: false, result: textResult("ok") });
	await h.emit("agent_settled");
	assert.equal(existsSync(join(h.ctx.cwd, ".mcp-pid")), false);
	assert.equal(h.controller.snapshot(h.ctx).pendingMutation, false);
	h.controller.setSession(h.ctx, { worktreeMode: "inherit" });
	assert.equal(h.controller.snapshot(h.ctx).effectiveMode, "enforce");
	assert.equal((await h.emit("tool_call", { toolName: "bash", toolCallId: "read2", input: { command: "cat local.ts" } })).block, true);
	// Indexed cwd is nested, never widened to the worktree/repository root.
	assert.equal(isScopedPath(h.ctx.cwd, join(worktree, "source.ts")), false);
	assert.equal(classifyGrep(main, { pattern: "where is behavior", path: worktree }), undefined);
	assert.equal(classifyBash(main, `cat '${join(worktree, "source.ts")}'`), undefined);
});

test("routing: source guards only classify provably scoped simple shell commands", (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const cwd = join(temp.root, "repo"); mkdirSync(cwd);
	const blocked = [
		"cat src/file.ts", "head -n 20 src/file.ts", "tail -n 10 src/file.ts 2>/dev/null", "sed '1,20p' src/file.ts",
		"sed -i 's/old/new/' src/file.ts", "perl -i -pe 's/old/new/' src/file.ts", "tee file.ts", "tee -a file.ts",
		"printf 'new contents' > file.ts", "echo data >> file.ts", "cat src/a.ts > src/b.ts",
		"rg 'where is behavior' src", "grep -n 'where is behavior' .",
	];
	for (const command of blocked) assert.ok(classifyBash(cwd, command), command);
	const allowed = [
		"cat ../outside.ts", `cat ${temp.root}/outside.ts`, "cat ./sub/../file.ts", "cd ../sibling && cat file.ts", "cd src; cat file.ts",
		"cat $TARGET", "cat *.ts", "cat $(pwd)/file.ts", "cat file.ts | head", "cat < source.ts", "head --unknown file.ts",
		"echo content > ../outside.ts", "cat ../outside.ts > inside.ts", "tee ../outside.ts", "sed -i 's/a/b/' ../outside.ts",
		"rg 'where is behavior' ../sibling", "rg --glob '*.ts' behavior", "rg validateToken src", "grep -F 'where is behavior' .",
		"npm test", "git diff", "printf x 2>/dev/null", "echo x 2>&1", "echo x > /dev/null", "git show HEAD:file.ts", "python -c 'print(1)'",
	];
	for (const command of allowed) assert.equal(classifyBash(cwd, command), undefined, command);
	assert.ok(classifyGrep(cwd, { pattern: "where is behavior" }));
	assert.equal(classifyGrep(cwd, { pattern: "validateToken" }), undefined);
	assert.equal(classifyGrep(cwd, { pattern: "where is behavior", path: "../sibling" }), undefined);
	assert.equal(classifyGrep(cwd, { pattern: "where is behavior", literal: true }), undefined);
});
