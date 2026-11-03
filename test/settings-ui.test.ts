import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { openRouterSettings, registerSettingsCommand, RouterSettingsComponent } from "../src/settings-ui.js";
import { fieldView, FIELDS, parseTextField } from "../src/settings-model.js";
import { harness, jsonFile, tempDirectory } from "./harness.js";

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", tab: "\t", pageUp: "\x1b[5~", pageDown: "\x1b[6~", backspace: "\x7f" };
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
// ANSI styling must never count toward the rendered width.
const ansi = { fg: (_color: string, text: string) => `\x1b[38;5;214m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const field = (key: string) => 1 + FIELDS.findIndex((spec) => spec.key === key);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

interface Opened { component: RouterSettingsComponent; options: any; result: Promise<unknown> }
function setup(root: string, options: { env?: Record<string, string>; keybindings?: KeybindingsConfig; rows?: number; theme?: typeof plain; mode?: string } = {}) {
	const env = { XDG_CONFIG_HOME: join(root, "config"), ...options.env };
	const h = harness(root, { openSettings: openRouterSettings, env });
	registerSettingsCommand(h.pi, h.controller);
	const ctx = h.ctx as any;
	ctx.mode = options.mode ?? "tui";
	const opened: Opened[] = [];
	let renders = 0;
	const tui = { requestRender: () => { renders++; }, terminal: { rows: options.rows ?? 40, columns: 100 } };
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, options.keybindings ?? {});
	ctx.ui.custom = (factory: any, customOptions: any) => {
		let resolveResult!: (value: unknown) => void;
		const result = new Promise((resolve) => { resolveResult = resolve; });
		opened.push({ component: factory(tui, options.theme ?? plain, keybindings, resolveResult), options: customOptions, result });
		return result;
	};
	const paths = { global: join(root, "config", "codebase-index", "router.json"), local: join(h.ctx.cwd, ".codebase-index", "router.json") };
	return {
		...h, ctx, opened, tui, paths, renders: () => renders,
		/** Starts the command without awaiting it: the custom component stays open until done(). */
		open(args = "") { const closed = h.command(args, "cbrouter-settings"); return { closed, ui: opened.at(-1)! }; },
	};
}
function press(component: RouterSettingsComponent, ...keys: string[]) { for (const key of keys) component.handleInput(key); }
function type(component: RouterSettingsComponent, text: string) { for (const char of text) component.handleInput(char); }
const screen = (component: RouterSettingsComponent, width = 100) => component.render(width).join("\n");

test("settings ui: inline custom screen reports blocked question, captures paging, closes via done", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root); await h.emit("session_start", { reason: "startup" });
	const { closed, ui } = h.open("global");
	// Inline (no overlay option) so the blocked program status applies.
	assert.deepEqual(ui.options, { blocked: { kind: "question", message: "Router settings" } });
	assert.equal(ui.component.capturesViewportInput, true);
	const text = screen(ui.component);
	assert.match(text, /Router settings/); assert.match(text, /Scope Global/);
	assert.ok(text.includes(h.paths.global), "actual global path shown");
	assert.match(text, /Effective: enforce/);
	assert.match(text, /up\/down move · enter change · tab scope · esc close/);
	press(ui.component, KEY.esc);
	await closed;
	assert.equal(existsSync(h.paths.global), false, "closing writes nothing");
});

test("settings ui: global changes apply immediately; cancel never saves", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root); await h.emit("session_start", { reason: "startup" });
	const { closed, ui } = h.open("global");
	const c = ui.component;
	press(c, KEY.down, KEY.enter);
	assert.match(screen(c), /Mode · Global/); assert.match(screen(c), /Inherit \(default: enforce\) \(current\)/);
	press(c, KEY.down, KEY.esc);
	assert.equal(existsSync(h.paths.global), false, "picker cancel saves nothing");
	press(c, KEY.enter, KEY.down, KEY.down, KEY.enter); // inherit -> enforce -> warn
	assert.deepEqual(readJson(h.paths.global), { mode: "warn" });
	assert.equal(h.controller.snapshot(h.ctx).sources.mode, "global");
	assert.match(h.statuses.at(-1)!, /codebase-router: warn/, "footer status refreshed immediately");
	assert.match(screen(c), /Saved Mode = warn to global/);
	// Boolean toggle
	press(c, KEY.down, KEY.down, KEY.enter, KEY.down, KEY.enter);
	assert.deepEqual(readJson(h.paths.global), { mode: "warn", autoIndex: true });
	press(c, KEY.esc); await closed;
});

test("settings ui: local inherit removes the key so global is not masked; reset requires a choice", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root);
	jsonFile(h.paths.global, { mode: "warn", worktreeMode: "inherit" });
	jsonFile(h.paths.local, { mode: "off", autoIndex: true, custom: "kept" });
	await h.emit("session_start", { reason: "startup" });
	const { closed, ui } = h.open();
	const c = ui.component;
	assert.equal(c.currentScope, "local", "existing trusted local file opens local scope");
	let text = screen(c);
	assert.ok(text.includes(h.paths.local));
	assert.match(text, /Mode\s+off/); assert.match(text, /Linked worktrees\s+from global: inherit/);
	press(c, KEY.down, KEY.enter);
	assert.match(screen(c), /Inherit \(global: warn\)/);
	press(c, KEY.up, KEY.up, KEY.up, KEY.enter); // current off -> inherit
	assert.deepEqual(readJson(h.paths.local), { autoIndex: true, custom: "kept" }, "unknown keys preserved");
	assert.equal(h.controller.snapshot(h.ctx).values.mode, "warn");
	assert.equal(h.controller.snapshot(h.ctx).sources.mode, "global");
	// Reset row: default choice is Cancel.
	const resetRow = FIELDS.length + 1;
	for (let i = 1; i < resetRow; i++) press(c, KEY.down);
	press(c, KEY.enter);
	text = screen(c);
	assert.match(text, /Reset local file\?/); assert.match(text, /› Cancel/);
	press(c, KEY.enter);
	assert.deepEqual(readJson(h.paths.local), { autoIndex: true, custom: "kept" });
	press(c, KEY.enter, KEY.down, KEY.enter);
	assert.deepEqual(readJson(h.paths.local), { custom: "kept" });
	assert.equal(h.controller.snapshot(h.ctx).values.worktreeMode, "inherit");
	// Tab switches to the global file without touching local.
	press(c, KEY.tab);
	assert.equal(c.currentScope, "global"); assert.ok(screen(c).includes(h.paths.global));
	press(c, KEY.esc); await closed;
});

test("settings ui: text fields validate, keep drafts on failure, empty inherits, cancel discards", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root); await h.emit("session_start", { reason: "startup" });
	const { closed, ui } = h.open("global");
	const c = ui.component;
	c.focused = true;
	for (let i = 0; i < field("indexTimeoutMs"); i++) press(c, KEY.down);
	press(c, KEY.enter);
	assert.match(screen(c), /Index timeout \(ms\) · Global/);
	assert.ok(c.render(100).some((line) => line.includes(CURSOR_MARKER)), "focus propagates to Input");
	type(c, "12.5"); press(c, KEY.enter);
	assert.match(screen(c), /must be a whole number/); assert.match(screen(c), /12\.5/, "draft kept");
	assert.equal(existsSync(h.paths.global), false);
	press(c, KEY.backspace, KEY.backspace, KEY.backspace, KEY.backspace); type(c, "3000000000"); press(c, KEY.enter);
	assert.match(screen(c), /between 1 and 2147483647/);
	press(c, KEY.esc);
	assert.equal(existsSync(h.paths.global), false, "input cancel saves nothing");
	assert.doesNotMatch(screen(c), /between 1 and/, "cancel clears the error");
	press(c, KEY.enter); type(c, "60000"); press(c, KEY.enter);
	assert.deepEqual(readJson(h.paths.global), { indexTimeoutMs: 60000 });
	press(c, KEY.enter);
	assert.match(screen(c), /60000/, "editor prefilled from layer value");
	for (let i = 0; i < 5; i++) press(c, KEY.backspace);
	press(c, KEY.enter);
	assert.deepEqual(readJson(h.paths.global), {}, "empty input removes the key");
	press(c, KEY.esc); await closed;
});

test("settings ui: prefilled editor places the cursor after the saved value", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root);
	jsonFile(h.paths.global, { indexTimeoutMs: 600000 });
	await h.emit("session_start", { reason: "startup" });
	const { closed, ui } = h.open("global");
	const c = ui.component;
	for (let i = 0; i < field("indexTimeoutMs"); i++) press(c, KEY.down);
	press(c, KEY.enter, KEY.backspace); type(c, "1"); press(c, KEY.enter);
	assert.deepEqual(readJson(h.paths.global), { indexTimeoutMs: 600001 });
	press(c, KEY.esc); await closed;
});

test("settings ui: save failures stay visible and retain the draft", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root);
	mkdirSync(join(temp.root, "config", "codebase-index"), { recursive: true });
	writeFileSync(h.paths.global, "{ not json");
	await h.emit("session_start", { reason: "startup" });
	const { closed, ui } = h.open("global");
	const c = ui.component;
	assert.match(screen(c, 200), /Repair the file before saving/);
	for (let i = 0; i < field("indexBin"); i++) press(c, KEY.down);
	press(c, KEY.enter); type(c, "/opt/index-cli"); press(c, KEY.enter);
	const text = screen(c);
	assert.match(text, /Index CLI · Global/, "still editing"); assert.match(text, /\/opt\/index-cli/);
	assert.match(text, /JSON/);
	assert.equal(readFileSync(h.paths.global, "utf8"), "{ not json", "malformed file untouched");
	press(c, KEY.esc, KEY.up, KEY.up, KEY.up, KEY.up, KEY.up, KEY.enter, KEY.down, KEY.enter);
	assert.match(screen(c), /JSON/, "picker save error visible");
	press(c, KEY.esc, KEY.esc); await closed;
});

test("settings ui: untrusted local is read-only; session/env overrides are shown and session clears", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root, { env: { PI_CODEBASE_ROUTER_MODE: "warn" } });
	jsonFile(h.paths.local, { mode: "enforce" });
	h.setTrusted(false);
	await h.emit("session_start", { reason: "startup" });
	await h.command("off");
	const { closed, ui } = h.open("local");
	const c = ui.component;
	let text = screen(c);
	assert.match(text, /Project is not trusted; local router settings are ignored. Trust the project to edit it./);
	assert.match(text, /Scope\s+Local · read-only/);
	assert.match(text, /Environment overrides: mode=warn \(PI_CODEBASE_ROUTER_MODE\)/);
	assert.match(text, /Session overrides: mode=off/);
	assert.match(text, /Mode\s+from default: enforce\s+session: off/);
	assert.match(text, /Effective: off/);
	press(c, KEY.down, KEY.enter);
	assert.match(screen(c), /local settings cannot be saved/);
	assert.deepEqual(readJson(h.paths.local), { mode: "enforce" });
	press(c, KEY.up, KEY.up, KEY.enter); // wraps to Session overrides
	text = screen(c);
	assert.match(text, /Clear session overrides/); assert.match(text, /› Clear all/);
	press(c, KEY.enter);
	assert.deepEqual(h.controller.snapshot(h.ctx).layers.session, {});
	text = screen(c);
	assert.match(text, /Session overrides cleared/);
	assert.match(text, /Mode\s+from default: enforce\s+environment: warn/);
	assert.match(text, /Effective: warn/);
	// Global stays editable while local is untrusted.
	press(c, KEY.tab, KEY.down, KEY.down, KEY.down, KEY.enter, KEY.down, KEY.enter); // session row -> scope -> mode -> worktrees
	assert.deepEqual(readJson(h.paths.global), { worktreeMode: "off" });
	press(c, KEY.esc); await closed;
});

test("settings ui: remapped selection and page keys come from injected keybindings", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root, { rows: 12, keybindings: {
		"tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p", "tui.select.pageDown": "ctrl+f", "tui.select.pageUp": "ctrl+b",
		"tui.select.confirm": "ctrl+o", "tui.select.cancel": "ctrl+g", "tui.input.tab": "ctrl+t",
	} });
	await h.emit("session_start", { reason: "startup" });
	const { closed, ui } = h.open("global");
	const c = ui.component;
	assert.match(screen(c), /ctrl\+p\/ctrl\+n move · ctrl\+o change · ctrl\+t scope · ctrl\+g close/);
	press(c, KEY.down, KEY.enter, KEY.esc, KEY.pageDown);
	assert.match(screen(c), /› Scope/, "default keys are not hard-coded");
	press(c, "\x0e");
	assert.match(screen(c), /› Mode/);
	press(c, "\x06");
	assert.doesNotMatch(screen(c), /› Mode/, "page down moved");
	assert.match(screen(c), /\(\d+\/10\)/, "short terminal shows a scroll position");
	press(c, "\x02", "\x02");
	assert.match(screen(c), /› Scope/);
	press(c, "\x14"); assert.equal(c.currentScope, "local");
	press(c, "\x14", "\x0e", "\x0f");
	assert.match(screen(c), /Mode · Global/);
	press(c, "\x0e", "\x0f");
	assert.deepEqual(readJson(h.paths.global), { mode: "enforce" });
	assert.ok(h.renders() > 0, "state changes request renders");
	press(c, "\x07"); await closed;
});

test("settings ui: every line fits narrow and resized widths in all views", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root, { theme: ansi, env: { PI_CODEBASE_ROUTER_MODE: "warn", PI_CODEBASE_INDEX_BIN: "/very/long/path/to/an/index/binary/that/does/not/fit" } });
	jsonFile(h.paths.global, { mode: "off", indexBin: "/another/really/long/path/that/should/be/truncated/cleanly" });
	await h.emit("session_start", { reason: "startup" });
	await h.command("off");
	const { closed, ui } = h.open("global");
	const c = ui.component;
	c.focused = true;
	const check = (label: string, marker = "› ") => {
		for (const rows of [10, 14, 24, 40]) {
			h.tui.terminal.rows = rows;
			for (const width of [12, 20, 32, 40, 59, 60, 80, 120, 200]) {
				const lines = c.render(width);
				assert.ok(lines.length <= rows - 4 || lines.length <= 8, `${label} ${width}x${rows}: ${lines.length} lines`);
				if (rows >= 14) assert.ok(lines.some((line) => line.includes(marker)), `${label} ${width}x${rows}: selection visible`);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `${label} @${width}: ${JSON.stringify(line)}`);
			}
		}
		h.tui.terminal.rows = 40;
	};
	check("list");
	const wide = c.render(120).length, narrow = c.render(30).length;
	assert.ok(narrow > wide, "narrow layout wraps rather than overflowing");
	for (let i = 0; i < field("mode"); i++) press(c, KEY.down);
	check("list-selected");
	press(c, KEY.enter); check("picker");
	press(c, KEY.esc);
	for (let i = field("mode"); i < field("indexBin"); i++) press(c, KEY.down);
	press(c, KEY.enter); check("input", "> ");
	press(c, KEY.esc);
	press(c, KEY.up, KEY.up, KEY.up, KEY.up, KEY.up, KEY.up, KEY.up, KEY.enter); check("session picker");
	press(c, KEY.esc);
	const before = c.render(80);
	c.invalidate();
	assert.deepEqual(c.render(80), before, "invalidate rebuilds identical output");
	press(c, KEY.esc); await closed;
});

test("settings ui: RPC uses native dialogs; print/json get actionable usage; argument errors are visible", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root, { mode: "rpc" });
	await h.emit("session_start", { reason: "startup" });
	const prompts: string[] = [];
	let custom = 0;
	h.ctx.ui.custom = () => { custom++; return Promise.resolve(undefined); };
	const answers: ((options: string[]) => string | undefined)[] = [
		(options) => options.find((option) => option.startsWith("Mode:")),
		(options) => options.find((option) => option === "warn"),
		(options) => options.find((option) => option.startsWith("Index timeout")),
		(options) => options.find((option) => option === "Close"),
	];
	const inputs = ["abc", "45000"];
	h.ctx.ui.select = async (title: string, options: string[]) => { prompts.push(title); return answers.shift()!(options); };
	h.ctx.ui.input = async (title: string) => { prompts.push(title); return inputs.shift(); };
	await h.command("settings global");
	assert.equal(custom, 0, "no custom component in RPC");
	assert.deepEqual(readJson(h.paths.global), { mode: "warn", indexTimeoutMs: 45000 });
	assert.ok(prompts[0]!.includes(h.paths.global));
	assert.ok(h.notifications.some((note) => note.type === "error" && /whole number/.test(note.text)), "invalid input reported");
	await h.command("bogus", "cbrouter-settings");
	assert.match(h.notifications.at(-1)!.text, /Usage: \/cbrouter-settings \[global\|local\]/);
	assert.equal(h.notifications.at(-1)!.type, "error");
	h.ctx.mode = "print"; h.ctx.hasUI = false;
	await assert.rejects(h.command("", "cbrouter-settings"), (error: Error) => /\/cbrouter \[local\|global\] off/.test(error.message) && error.message.includes(h.paths.global));
	await assert.rejects(h.command("config"), /interactive TUI or an RPC client/);
	h.ctx.mode = "json";
	await assert.rejects(h.command("local", "cbrouter-settings"), /interactive TUI/);
	await h.command("status").catch(() => assert.fail("textual status remains available"));
});

test("settings ui: /cbrouter settings|config [global|local] alias passes the scope", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const scopes: (string | undefined)[] = [];
	const h = harness(temp.root, { async openSettings(_controller, _ctx, scope) { scopes.push(scope); } });
	await h.emit("session_start", { reason: "startup" });
	for (const args of ["", "settings", "config", "settings global", "config local"]) await h.command(args);
	assert.deepEqual(scopes, [undefined, undefined, undefined, "global", "local"]);
	await h.command("config nowhere");
	assert.match(h.notifications.at(-1)!.text, /Usage: .*\/cbrouter settings \[global\|local\]/);
	const values = (await h.commandDefinition.getArgumentCompletions!("co"))!.map((item) => item.value);
	assert.deepEqual(values, ["config"]);
});

test("settings model: scope views use layer values and report shadowing", async (t) => {
	const temp = tempDirectory(); t.after(temp.cleanup);
	const h = setup(temp.root);
	jsonFile(h.paths.global, { mode: "warn" });
	jsonFile(h.paths.local, { mode: "off" });
	await h.emit("session_start", { reason: "startup" });
	const state = h.controller.snapshot(h.ctx);
	const mode = FIELDS[0]!;
	assert.deepEqual(fieldView(state, "global", mode), { spec: mode, setHere: true, layerValue: "warn", inherited: { value: "enforce", source: "default" }, effective: { value: "off", source: "local" }, shadowedBy: "local" });
	assert.equal(fieldView(state, "local", mode).shadowedBy, undefined);
	assert.deepEqual(fieldView(state, "local", mode).inherited, { value: "warn", source: "global" });
	const timeout = FIELDS.find((spec) => spec.key === "indexTimeoutMs")!;
	assert.deepEqual(parseTextField(timeout, " 15 "), { indexTimeoutMs: 15 });
	assert.deepEqual(parseTextField(timeout, ""), { indexTimeoutMs: null });
	assert.throws(() => parseTextField(timeout, "0"), /between 1/);
	assert.throws(() => parseTextField(timeout, "-1"), /whole number/);
	assert.deepEqual(parseTextField(FIELDS.find((spec) => spec.key === "indexBin")!, "  ./bin/cli "), { indexBin: "./bin/cli" });
});
