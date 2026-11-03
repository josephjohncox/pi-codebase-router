import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectPageIndex, Input, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type Keybinding, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import type { ConfigKey, ConfigPatch, ConfigScope } from "./config.js";
import type { RouterController, RouterSnapshot } from "./controller.js";
import {
	choiceLabels, choiceValue, defaultScope, describeOverrides, effectiveSummary, FIELDS, fieldView, fileNotice,
	formatValue, parseTextField, scopeLabel, sourceLabel, statusNotes, type FieldSpec, type FieldView,
} from "./settings-model.js";

export const SETTINGS_USAGE = "Usage: /cbrouter-settings [global|local]";
type Tone = "accent" | "muted" | "dim" | "success" | "error" | "warning" | "borderMuted";
export type SettingsTheme = Pick<Theme, "fg" | "bold">;
type Row = { kind: "scope" } | { kind: "field"; spec: FieldSpec } | { kind: "reset" } | { kind: "session" };
interface Choice { label: string; detail?: string; current?: boolean; run?: () => RouterSnapshot; done?: string }
type View = { kind: "list" } | { kind: "pick"; title: string; choices: Choice[]; index: number } | { kind: "input"; spec: FieldSpec };
const ROWS: readonly Row[] = [{ kind: "scope" }, ...FIELDS.map((spec) => ({ kind: "field" as const, spec })), { kind: "reset" }, { kind: "session" }];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const otherScope = (scope: ConfigScope): ConfigScope => scope === "global" ? "local" : "global";
const savedKeys = (state: RouterSnapshot, scope: ConfigScope) => Object.keys(state.layers[scope].values) as ConfigKey[];
const nullPatch = (keys: readonly ConfigKey[]) => Object.fromEntries(keys.map((key) => [key, null])) as ConfigPatch;
function rowValue(view: FieldView, narrow = false): string {
	if (view.setHere) return formatValue(view.spec.key, view.layerValue);
	return `${narrow ? "" : "from "}${sourceLabel(view.inherited.source)}: ${formatValue(view.spec.key, view.inherited.value)}`;
}
function inheritChoice(view: FieldView): string {
	return `Inherit (${sourceLabel(view.inherited.source)}: ${formatValue(view.spec.key, view.inherited.value)})`;
}
/** Keep the end of long paths, which identifies the file. */
function truncateStart(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let tail = text;
	while (tail.length && visibleWidth(tail) > width - 1) tail = tail.slice(1);
	return `…${tail}`;
}

export interface RouterSettingsDeps {
	controller: RouterController;
	ctx: ExtensionContext;
	tui: Pick<TUI, "requestRender"> & { terminal?: { rows: number } };
	theme: SettingsTheme;
	keybindings: KeybindingsManager;
	done: () => void;
	scope?: ConfigScope;
}
/** Inline router settings screen. Every change is applied through the controller immediately. */
export class RouterSettingsComponent implements Component, Focusable {
	/** PageUp/PageDown page the settings list instead of the fullscreen transcript. */
	readonly capturesViewportInput = true;
	private state: RouterSnapshot;
	private scope: ConfigScope;
	private selected = 0;
	private view: View = { kind: "list" };
	private message?: { tone: Tone; text: string };
	private input = new Input();
	private focusedValue = false;
	private cache?: { width: number; rows: number; lines: string[] };
	constructor(private readonly deps: RouterSettingsDeps) {
		this.state = deps.controller.snapshot(deps.ctx);
		this.scope = deps.scope ?? defaultScope(this.state);
	}
	get focused(): boolean { return this.focusedValue; }
	set focused(value: boolean) { this.focusedValue = value; this.input.focused = value; }
	/** Test/inspection seam; not used for persistence. */
	get currentScope(): ConfigScope { return this.scope; }

	invalidate(): void { this.cache = undefined; this.input.invalidate(); }
	private changed(): void { this.invalidate(); this.deps.tui.requestRender(); }
	private matches(data: string, binding: Keybinding): boolean { return this.deps.keybindings.matches(data, binding); }
	private key(binding: Keybinding): string {
		const key = this.deps.keybindings.getKeys(binding)[0];
		return key === undefined ? "unbound" : key === "escape" ? "esc" : key;
	}
	private refresh(): void {
		try { this.state = this.deps.controller.snapshot(this.deps.ctx); }
		catch (error) { this.message = { tone: "error", text: errorText(error) }; }
	}
	/** Returns false and keeps the current view/draft when the controller rejects the change. */
	private apply(action: () => RouterSnapshot, success: string): boolean {
		try {
			this.state = action();
			this.message = { tone: "success", text: success };
			return true;
		} catch (error) {
			this.message = { tone: "error", text: errorText(error) };
			this.refresh();
			return false;
		}
	}
	private readOnly(): string | undefined {
		return this.scope === "local" && this.state.layers.local.ignored ? "Project is not trusted; local settings cannot be saved." : undefined;
	}
	private save(patch: ConfigPatch, success: string): boolean {
		const scope = this.scope;
		return this.apply(() => this.deps.controller.save(this.deps.ctx, scope, patch), success);
	}
	private switchScope(): void {
		this.scope = otherScope(this.scope);
		this.message = undefined;
		this.refresh();
	}

	handleInput(data: string): void {
		if (this.view.kind === "input") this.handleTextInput(data);
		else if (this.view.kind === "pick") this.handlePick(this.view, data);
		else this.handleList(data);
	}
	private move(data: string, index: number, count: number, page: number): number | undefined {
		if (count === 0) return undefined;
		if (this.matches(data, "tui.select.up")) return index === 0 ? count - 1 : index - 1;
		if (this.matches(data, "tui.select.down")) return index === count - 1 ? 0 : index + 1;
		return getSelectPageIndex(this.deps.keybindings, data, index, count, page);
	}
	private handleList(data: string): void {
		const next = this.move(data, this.selected, ROWS.length, this.pageSize());
		if (next !== undefined) { this.selected = next; this.changed(); return; }
		if (this.matches(data, "tui.select.cancel")) { this.deps.done(); return; }
		if (this.matches(data, "tui.input.tab")) { this.switchScope(); this.changed(); return; }
		if (this.matches(data, "tui.select.confirm") || data === " ") { this.activate(ROWS[this.selected]!); this.changed(); }
	}
	private handlePick(view: Extract<View, { kind: "pick" }>, data: string): void {
		const next = this.move(data, view.index, view.choices.length, this.pageSize());
		if (next !== undefined) { view.index = next; this.changed(); return; }
		if (this.matches(data, "tui.select.cancel")) { this.view = { kind: "list" }; this.message = undefined; this.changed(); return; }
		if (this.matches(data, "tui.select.confirm") || data === " ") {
			const choice = view.choices[view.index]!;
			if (!choice.run) { this.view = { kind: "list" }; this.message = undefined; }
			else if (this.apply(choice.run, choice.done ?? "Saved")) this.view = { kind: "list" };
			this.changed();
		}
	}
	private handleTextInput(data: string): void {
		const view = this.view as Extract<View, { kind: "input" }>;
		if (this.matches(data, "tui.select.cancel")) { this.view = { kind: "list" }; this.message = undefined; this.changed(); return; }
		if (this.matches(data, "tui.input.submit")) { this.submitText(view.spec, this.input.getValue()); this.changed(); return; }
		this.input.handleInput(data);
		this.changed();
	}
	private submitText(spec: FieldSpec, raw: string): void {
		let patch: ConfigPatch;
		try { patch = parseTextField(spec, raw); }
		catch (error) { this.message = { tone: "error", text: errorText(error) }; return; }
		const value = patch[spec.key];
		const text = value === null ? `${spec.label} now inherits in ${this.scope}` : `Saved ${spec.label} = ${formatValue(spec.key, value)} to ${this.scope}`;
		// On failure the draft stays in the input so it can be corrected.
		if (this.save(patch, text)) this.view = { kind: "list" };
	}
	private activate(row: Row): void {
		this.message = undefined;
		if (row.kind === "scope") { this.switchScope(); return; }
		if (row.kind === "session") { this.openSessionPicker(); return; }
		const locked = this.readOnly();
		if (locked) { this.message = { tone: "error", text: locked }; return; }
		if (row.kind === "reset") { this.openResetPicker(); return; }
		const view = fieldView(this.state, this.scope, row.spec);
		const { spec } = row;
		if (spec.kind === "text" || spec.kind === "integer") {
			this.startInput(view.setHere ? String(view.layerValue) : "");
			this.view = { kind: "input", spec };
			return;
		}
		const scope = this.scope;
		const choices: Choice[] = [
			{ label: inheritChoice(view), current: !view.setHere, run: () => this.deps.controller.save(this.deps.ctx, scope, { [spec.key]: null }), done: `${spec.label} now inherits in ${scope}` },
			...choiceLabels(spec).map((label) => ({
				label, current: view.setHere && formatValue(spec.key, view.layerValue) === label,
				run: () => this.deps.controller.save(this.deps.ctx, scope, { [spec.key]: choiceValue(spec, label) }),
				done: `Saved ${spec.label} = ${label} to ${scope}`,
			})),
		];
		this.view = { kind: "pick", title: `${spec.label} · ${scopeLabel(scope)}`, choices, index: Math.max(0, choices.findIndex((choice) => choice.current)) };
	}
	/** Fresh Input per edit; the prefill is pasted so the cursor ends after it. */
	private startInput(value: string): void {
		this.input = new Input();
		this.input.focused = this.focusedValue;
		if (value) this.input.handleInput(`\x1b[200~${value}\x1b[201~`);
	}
	private openResetPicker(): void {
		const scope = this.scope;
		const keys = savedKeys(this.state, scope);
		if (keys.length === 0) { this.message = { tone: "muted", text: `Nothing saved in the ${scope} file.` }; return; }
		this.view = { kind: "pick", title: `Reset ${scope} file?`, index: 0, choices: [
			{ label: "Cancel" },
			{ label: `Remove ${keys.length} saved setting${keys.length === 1 ? "" : "s"}`, detail: keys.join(", "),
				run: () => this.deps.controller.save(this.deps.ctx, scope, nullPatch(keys)), done: `Reset ${scope} file; values now inherit` },
		] };
	}
	private openSessionPicker(): void {
		const keys = Object.keys(this.state.layers.session) as ConfigKey[];
		if (keys.length === 0) { this.message = { tone: "muted", text: "No session overrides. Use /cbrouter off|warn|enforce for this session only." }; return; }
		const { ctx, controller } = this.deps;
		this.view = { kind: "pick", title: "Clear session overrides", index: 0, choices: [
			{ label: "Clear all", detail: describeOverrides(this.state.layers.session).join(", "), run: () => controller.clearSession(ctx), done: "Session overrides cleared" },
			...keys.map((key) => ({ label: `Clear ${key}`, detail: formatValue(key, this.state.layers.session[key]), run: () => controller.clearSession(ctx, [key]), done: `Session override ${key} cleared` })),
			{ label: "Cancel" },
		] };
	}

	private rows(): number { return Math.max(10, this.deps.tui.terminal?.rows ?? 24); }
	/** Page size follows the rows actually visible in the last render. */
	private pageSize(): number { return Math.max(1, this.visibleRows); }
	private visibleRows = 5;
	render(width: number): string[] {
		const rows = this.rows();
		if (this.cache && this.cache.width === width && this.cache.rows === rows) return this.cache.lines;
		const lines = this.compose(Math.max(1, width), rows).map((line) => truncateToWidth(line, Math.max(1, width)));
		this.cache = { width, rows, lines };
		return lines;
	}
	/** Wrapped text normally; one truncated line when space is tight. */
	private text(text: string, width: number, tone: Tone | undefined, compact: boolean): string[] {
		if (compact) return [truncateToWidth(tone ? this.deps.theme.fg(tone, text) : text, Math.max(1, width))];
		return wrapTextWithAnsi(text, Math.max(1, width)).map((line) => tone ? this.deps.theme.fg(tone, line) : line);
	}
	/** Leaves room for Pi's own editor border and footer; progressively compacts to stay within it. */
	private compose(width: number, rows: number): string[] {
		const max = Math.max(8, rows - 4);
		let lines: string[] = [];
		for (let level = 0; level <= 3; level++) {
			lines = this.layout(width, max, level);
			if (lines.length <= max) return lines;
		}
		// Keep the rows, message and key hints over the title in extremely short terminals.
		return lines.slice(-max);
	}
	private layout(width: number, max: number, level: number): string[] {
		const { theme } = this.deps;
		const state = this.state;
		const compact = level > 0;
		const border = theme.fg("borderMuted", "─".repeat(width));
		const scopeLine = `Scope ${theme.fg("accent", scopeLabel(this.scope))} ${theme.fg("dim", `(${this.key("tui.input.tab")}: ${otherScope(this.scope)})`)}`;
		const path = theme.fg("muted", truncateStart(state.layers[this.scope].path, width));
		if (level >= 3) {
			// Minimal: rows, message and hints first; status details stay in the selected row description.
			const header = [`${theme.bold(theme.fg("accent", "Router settings"))} · ${scopeLine}`, path];
			const footer = [...(this.message ? this.text(this.message.text, width, this.message.tone, true) : []), ...this.text(this.hint(), width, "dim", true), border];
			const budget = max - header.length - footer.length;
			const body = this.view.kind === "input" ? this.renderInput(this.view.spec, width, true)
				: this.view.kind === "pick" ? this.renderPick(this.view, width, budget) : this.renderList(width, budget, level);
			return [...header, ...body, ...footer];
		}
		const header: string[] = [border, theme.bold(theme.fg("accent", "Router settings")), scopeLine, path];
		const notice = fileNotice(state, this.scope);
		if (notice) header.push(...this.text(notice.text, width, notice.tone, compact));
		header.push(...this.text(effectiveSummary(state), width, undefined, compact));
		const env = describeOverrides(state.layers.env, true);
		if (env.length) header.push(...this.text(`Environment overrides: ${env.join(", ")}`, width, "warning", compact));
		const session = describeOverrides(state.layers.session);
		if (session.length) header.push(...this.text(`Session overrides: ${session.join(", ")}`, width, "warning", compact));
		for (const note of statusNotes(state)) header.push(...this.text(note, width, "warning", compact));
		if (level < 2) header.push("");
		const footer: string[] = level < 2 ? [""] : [];
		if (this.message) footer.push(...this.text(this.message.text, width, this.message.tone, compact));
		footer.push(...this.text(this.hint(), width, "dim", false), border);
		const budget = max - header.length - footer.length;
		const body = this.view.kind === "input" ? this.renderInput(this.view.spec, width, compact)
			: this.view.kind === "pick" ? this.renderPick(this.view, width, budget)
			: this.renderList(width, budget, level);
		return [...header, ...body, ...footer];
	}
	private hint(): string {
		const move = `${this.key("tui.select.up")}/${this.key("tui.select.down")}`;
		if (this.view.kind === "input") return `${this.key("tui.input.submit")} save · empty inherits · ${this.key("tui.select.cancel")} back`;
		if (this.view.kind === "pick") return `${move} move · ${this.key("tui.select.confirm")} choose · ${this.key("tui.select.cancel")} back`;
		return `${move} move · ${this.key("tui.select.confirm")} change · ${this.key("tui.input.tab")} scope · ${this.key("tui.select.cancel")} close`;
	}
	private window(count: number, index: number, size: number): { start: number; end: number } {
		const visible = Math.max(1, Math.min(count, size));
		const start = Math.max(0, Math.min(index - Math.floor(visible / 2), count - visible));
		this.visibleRows = visible;
		return { start, end: start + visible };
	}
	private renderList(width: number, budget: number, level: number): string[] {
		const { theme } = this.deps;
		const state = this.state;
		const narrow = width < 60;
		const labelWidth = Math.min(narrow ? Math.max(8, Math.floor(width * 0.45)) : 24, 24);
		const description = level >= 2 ? [] : this.text(this.describe(ROWS[this.selected]!), width - 2, "muted", false).map((line) => `  ${line}`);
		const shown = level >= 1 ? description.slice(0, 2) : description;
		if (shown.length < description.length) shown[shown.length - 1] += this.deps.theme.fg("muted", " …");
		const extra = shown.length ? shown.length + 1 : 0;
		// Reserve one line for the scroll position whenever the list does not fit.
		const fits = budget - extra >= ROWS.length;
		const { start, end } = this.window(ROWS.length, this.selected, Math.max(3, budget - extra - (fits ? 0 : 1)));
		const lines: string[] = [];
		for (let index = start; index < end; index++) {
			const row = ROWS[index]!;
			const selected = index === this.selected;
			let label: string, value: string, note = "";
			if (row.kind === "scope") {
				label = "Scope";
				value = theme.fg("accent", scopeLabel(this.scope)) + (this.readOnly() ? theme.fg("warning", " · read-only") : "");
			} else if (row.kind === "reset") {
				const count = savedKeys(state, this.scope).length;
				label = "Reset file";
				value = theme.fg("dim", count ? `${count} saved` : "nothing saved");
			} else if (row.kind === "session") {
				const count = Object.keys(state.layers.session).length;
				label = "Session overrides";
				value = count ? theme.fg("warning", `${count} active`) : theme.fg("dim", "none");
			} else {
				const view = fieldView(state, this.scope, row.spec);
				label = row.spec.label;
				value = view.setHere ? theme.fg("accent", rowValue(view, narrow)) : theme.fg("dim", rowValue(view, narrow));
				if (view.shadowedBy) note = theme.fg("warning", `${sourceLabel(view.shadowedBy)}: ${formatValue(row.spec.key, view.effective.value)}`);
			}
			const prefix = selected ? theme.fg("accent", "› ") : "  ";
			const cut = truncateToWidth(label, labelWidth, "…");
			const padded = (selected ? theme.fg("accent", cut) : cut) + " ".repeat(Math.max(0, labelWidth - visibleWidth(cut)));
			const line = `${prefix}${padded}  ${value}`;
			const inline = note && visibleWidth(line) + visibleWidth(note) + 2 <= width;
			lines.push(inline ? `${line}  ${note}` : line);
			// Narrow layouts show the shadowing note under the row; compact ones leave it to the description.
			if (note && !inline && level === 0) lines.push(`${" ".repeat(Math.min(4, width))}${note}`);
		}
		if (!fits || start > 0 || end < ROWS.length) lines.push(theme.fg("dim", `  (${this.selected + 1}/${ROWS.length})`));
		if (shown.length) lines.push("", ...shown);
		return lines;
	}
	private describe(row: Row): string {
		if (row.kind === "scope") return this.scope === "global"
			? "Global settings apply to every project. Local project settings override them."
			: "Local settings apply to this project and override global ones. Inherit removes a key so the global value applies.";
		if (row.kind === "reset") return `Remove every router setting saved in the ${this.scope} file so all values inherit.`;
		if (row.kind === "session") return "Session overrides (from /cbrouter off|warn|enforce) beat every file. Clear them to use saved settings.";
		const view = fieldView(this.state, this.scope, row.spec);
		const effective = `Effective: ${formatValue(row.spec.key, view.effective.value)} from ${sourceLabel(view.effective.source)}.`;
		return `${row.spec.description} ${effective}${view.shadowedBy ? ` Changes here are shadowed by ${sourceLabel(view.shadowedBy)}.` : ""}`;
	}
	private renderPick(view: Extract<View, { kind: "pick" }>, width: number, budget: number): string[] {
		const { theme } = this.deps;
		const lines = [theme.bold(view.title)];
		const { start, end } = this.window(view.choices.length, view.index, Math.max(2, budget - 3));
		for (let index = start; index < end; index++) {
			const choice = view.choices[index]!;
			const selected = index === view.index;
			const text = `${selected ? theme.fg("accent", "› ") : "  "}${selected ? theme.fg("accent", choice.label) : choice.label}${choice.current ? theme.fg("dim", " (current)") : ""}`;
			lines.push(choice.detail && !(width < 50) ? `${text}  ${theme.fg("dim", choice.detail)}` : text);
		}
		if (start > 0 || end < view.choices.length) lines.push(theme.fg("dim", `  (${view.index + 1}/${view.choices.length})`));
		const detail = view.choices[view.index]?.detail;
		if (detail && width < 50) lines.push(...this.text(detail, width - 2, "dim", false).map((line) => `  ${line}`));
		return lines;
	}
	private renderInput(spec: FieldSpec, width: number, compact: boolean): string[] {
		const view = fieldView(this.state, this.scope, spec);
		const { theme } = this.deps;
		return [
			theme.bold(`${spec.label} · ${scopeLabel(this.scope)}`),
			...this.input.render(Math.max(1, width)),
			...this.text(`Empty inherits ${formatValue(spec.key, view.inherited.value)} from ${sourceLabel(view.inherited.source)}.`, width, "muted", compact),
		];
	}
}

/** Native dialogs for RPC clients, where custom components are unavailable. */
export async function runDialogSettings(controller: RouterController, ctx: ExtensionContext, initial?: ConfigScope): Promise<void> {
	let scope = initial ?? defaultScope(controller.snapshot(ctx));
	const ui = ctx.ui;
	const attempt = (action: () => RouterSnapshot, success: string): boolean => {
		try { action(); ui.notify(success, "info"); return true; }
		catch (error) { ui.notify(`Router settings failed: ${errorText(error)}`, "error"); return false; }
	};
	for (;;) {
		const state = controller.snapshot(ctx);
		const views = FIELDS.map((spec) => fieldView(state, scope, spec));
		const options = [
			`Scope: ${scopeLabel(scope)} (switch to ${otherScope(scope)})`,
			...views.map((view) => `${view.spec.label}: ${rowValue(view)}${view.shadowedBy ? ` [${sourceLabel(view.shadowedBy)}: ${formatValue(view.spec.key, view.effective.value)}]` : ""}`),
			`Reset ${scope} file`,
			`Clear session overrides (${Object.keys(state.layers.session).length})`,
			"Status",
			"Close",
		];
		const notice = fileNotice(state, scope);
		const title = [`Router settings · ${scopeLabel(scope)} · ${state.layers[scope].path}`, effectiveSummary(state), notice?.text].filter(Boolean).join("\n");
		const picked = await ui.select(title, options);
		const index = picked === undefined ? -1 : options.indexOf(picked);
		if (index < 0 || index === options.length - 1) return;
		if (index === 0) { scope = otherScope(scope); continue; }
		if (index === options.length - 2) {
			const env = describeOverrides(state.layers.env, true), session = describeOverrides(state.layers.session);
			ui.notify([effectiveSummary(state), ...views.map((view) => `${view.spec.key}: ${formatValue(view.spec.key, view.effective.value)} [${sourceLabel(view.effective.source)}]`),
				env.length ? `Environment overrides: ${env.join(", ")}` : "", session.length ? `Session overrides: ${session.join(", ")}` : "", ...statusNotes(state)].filter(Boolean).join("\n"), "info");
			continue;
		}
		if (index === options.length - 3) {
			const keys = Object.keys(state.layers.session) as ConfigKey[];
			if (!keys.length) { ui.notify("No session overrides.", "info"); continue; }
			const choices = ["Clear all", ...keys.map((key) => `Clear ${key}=${formatValue(key, state.layers.session[key])}`)];
			const choice = await ui.select("Clear session overrides", choices);
			const at = choice === undefined ? -1 : choices.indexOf(choice);
			if (at === 0) attempt(() => controller.clearSession(ctx), "Session overrides cleared");
			else if (at > 0) attempt(() => controller.clearSession(ctx, [keys[at - 1]!]), `Session override ${keys[at - 1]} cleared`);
			continue;
		}
		if (scope === "local" && state.layers.local.ignored) { ui.notify("Project is not trusted; local settings cannot be saved.", "error"); continue; }
		if (index === options.length - 4) {
			const keys = savedKeys(state, scope);
			if (!keys.length) { ui.notify(`Nothing saved in the ${scope} file.`, "info"); continue; }
			if (await ui.confirm(`Reset ${scope} file?`, `Remove ${keys.join(", ")} from ${state.layers[scope].path}`)) {
				attempt(() => controller.save(ctx, scope, nullPatch(keys)), `Reset ${scope} file`);
			}
			continue;
		}
		const view = views[index - 1]!;
		const { spec } = view;
		if (spec.kind === "text" || spec.kind === "integer") {
			let draft = view.setHere ? String(view.layerValue) : "";
			for (;;) {
				const raw = await ui.input(`${spec.label} (${scope}; empty inherits ${formatValue(spec.key, view.inherited.value)})`, draft);
				if (raw === undefined) break;
				draft = raw;
				let patch: ConfigPatch;
				try { patch = parseTextField(spec, raw); }
				catch (error) { ui.notify(errorText(error), "error"); continue; }
				if (attempt(() => controller.save(ctx, scope, patch), `Saved ${spec.label} to ${scope}`)) break;
			}
			continue;
		}
		const labels = [inheritChoice(view), ...choiceLabels(spec)];
		const choice = await ui.select(`${spec.label} (${scope})`, labels);
		const at = choice === undefined ? -1 : labels.indexOf(choice);
		if (at === 0) attempt(() => controller.save(ctx, scope, { [spec.key]: null }), `${spec.label} now inherits in ${scope}`);
		else if (at > 0) attempt(() => controller.save(ctx, scope, { [spec.key]: choiceValue(spec, labels[at]!) }), `Saved ${spec.label} = ${labels[at]} to ${scope}`);
	}
}

export function nonInteractiveUsage(state: RouterSnapshot): string {
	return [
		"Router settings need the interactive TUI or an RPC client.",
		"Use /cbrouter [local|global] off|on|toggle|warn|enforce|status|reset,",
		`or edit ${state.layers.global.path} (global) / ${state.layers.local.path} (local).`,
	].join(" ");
}
export async function openRouterSettings(controller: RouterController, ctx: ExtensionContext, scope?: ConfigScope): Promise<void> {
	if (ctx.mode === "tui") {
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => new RouterSettingsComponent({ controller, ctx, tui, theme, keybindings, done: () => done(undefined), scope }),
			{ blocked: { kind: "question", message: "Router settings" } });
		return;
	}
	if (ctx.hasUI) { await runDialogSettings(controller, ctx, scope); return; }
	throw new Error(nonInteractiveUsage(controller.snapshot(ctx)));
}
export function parseScopeArgument(args: string): ConfigScope | undefined {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return undefined;
	if (words.length === 1 && (words[0] === "global" || words[0] === "local")) return words[0];
	throw new Error(SETTINGS_USAGE);
}
export function registerSettingsCommand(pi: ExtensionAPI, controller: RouterController): void {
	pi.registerCommand("cbrouter-settings", {
		description: "Edit router settings: global or local file, session overrides, effective status",
		getArgumentCompletions(prefix) {
			const items = ["global", "local"].filter((value) => value.startsWith(prefix.trim()));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		async handler(args, ctx) {
			try {
				await openRouterSettings(controller, ctx, parseScopeArgument(args));
			} catch (error) {
				if (!ctx.hasUI) throw error;
				ctx.ui.notify(`Router settings failed: ${errorText(error)}`, "error");
			}
		},
	});
}
