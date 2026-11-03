import { DEFAULT_CONFIG, ENV_KEYS, type ConfigKey, type ConfigPatch, type ConfigScope, type ConfigSource, type RouterConfig } from "./config.js";
import type { RouterSnapshot } from "./controller.js";

/** Rendering-only metadata. Validation and precedence stay in the controller/config layer. */
export type FieldKind = "choice" | "toggle" | "text" | "integer";
export interface FieldSpec {
	key: ConfigKey;
	label: string;
	kind: FieldKind;
	choices?: readonly string[];
	description: string;
}
export const FIELDS: readonly FieldSpec[] = [
	{ key: "mode", label: "Mode", kind: "choice", choices: ["enforce", "warn", "off"],
		description: "enforce blocks exploratory grep/shell, warn only reports it, off disables routing." },
	{ key: "worktreeMode", label: "Linked worktrees", kind: "choice", choices: ["off", "inherit"],
		description: "off bypasses the router in linked Git worktrees; inherit applies Mode there too." },
	{ key: "autoIndex", label: "Index on session start", kind: "toggle",
		description: "Run an incremental index when a session starts, resumes or forks." },
	{ key: "autoIndexAfterWrite", label: "Index after edits", kind: "toggle",
		description: "Run an incremental index after successful in-project edit/write calls settle." },
	{ key: "autoIndexViaTurn", label: "Index via agent turn", kind: "toggle",
		description: "Queue an index_codebase follow-up turn instead of the background CLI. A queued turn cannot be retracted." },
	{ key: "indexBin", label: "Index CLI", kind: "text",
		description: "Path to the opencode-codebase-index CLI. Empty inherits; unset everywhere means auto-discovery." },
	{ key: "indexTimeoutMs", label: "Index timeout (ms)", kind: "integer",
		description: "Background index timeout in milliseconds (1 to 2147483647). Empty inherits." },
];
const RANK: Record<ConfigSource, number> = { default: 0, global: 1, local: 2, env: 3, session: 4 };
const MAX_TIMEOUT = 2_147_483_647;

export function formatValue(key: ConfigKey, value: unknown): string {
	if (value === undefined) return key === "indexBin" ? "auto" : "unset";
	if (typeof value === "boolean") return value ? "on" : "off";
	return String(value);
}
/** Value strings shown in pickers map back to typed config values. */
export function choiceValue(spec: FieldSpec, label: string): RouterConfig[ConfigKey] {
	if (spec.kind === "toggle") return label === "on";
	return label as RouterConfig[ConfigKey];
}
export function choiceLabels(spec: FieldSpec): readonly string[] {
	return spec.kind === "toggle" ? ["on", "off"] : spec.choices ?? [];
}
export interface FieldView {
	spec: FieldSpec;
	/** Value stored in the selected scope file, if any. */
	layerValue?: unknown;
	setHere: boolean;
	/** What this scope falls back to when the key is removed from it. */
	inherited: { value: unknown; source: ConfigSource };
	effective: { value: unknown; source: ConfigSource };
	/** A higher-priority layer (local over global, env, session) decides the effective value. */
	shadowedBy?: ConfigSource;
}
export function fieldView(state: RouterSnapshot, scope: ConfigScope, spec: FieldSpec): FieldView {
	const { key } = spec;
	const layer = state.layers[scope].values;
	const setHere = key in layer;
	const global = state.layers.global.values;
	const inherited = scope === "local" && key in global
		? { value: global[key], source: "global" as const }
		: { value: DEFAULT_CONFIG[key], source: "default" as const };
	const source = state.sources[key];
	return {
		spec, setHere, inherited, layerValue: setHere ? layer[key] : undefined,
		effective: { value: state.values[key], source },
		shadowedBy: RANK[source] > RANK[scope] ? source : undefined,
	};
}
/** Empty input means inherit (remove from this layer). */
export function parseTextField(spec: FieldSpec, raw: string): ConfigPatch {
	const text = raw.trim();
	if (!text) return { [spec.key]: null };
	if (spec.kind === "integer") {
		if (!/^\d+$/.test(text)) throw new Error(`${spec.label} must be a whole number of milliseconds`);
		const value = Number(text);
		if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT) throw new Error(`${spec.label} must be between 1 and ${MAX_TIMEOUT}`);
		return { [spec.key]: value };
	}
	return { [spec.key]: text };
}
export function scopeLabel(scope: ConfigScope): string { return scope === "global" ? "Global" : "Local"; }
export function sourceLabel(source: ConfigSource): string { return source === "env" ? "environment" : source; }
export function describeOverrides(values: Partial<RouterConfig>, env = false): string[] {
	return (Object.keys(values) as ConfigKey[]).map((key) => `${key}=${formatValue(key, values[key])}${env ? ` (${ENV_KEYS[key]})` : ""}`);
}
/** Initial scope: an existing trusted local file, otherwise global. */
export function defaultScope(state: RouterSnapshot): ConfigScope {
	const local = state.layers.local;
	return !local.ignored && (Object.keys(local.values).length > 0 || local.error) ? "local" : "global";
}
export function fileNotice(state: RouterSnapshot, scope: ConfigScope): { tone: "error" | "warning" | "muted"; text: string } | undefined {
	const layer = state.layers[scope];
	if (scope === "local" && layer.ignored) return { tone: "warning", text: `${layer.ignored}. Trust the project to edit it.` };
	if (layer.error) return { tone: "error", text: `${layer.error}. Repair the file before saving.` };
	if (Object.keys(layer.values).length === 0) return { tone: "muted", text: "No settings in this file; every value is inherited." };
	return undefined;
}
export function effectiveSummary(state: RouterSnapshot): string {
	const parts = [`Effective: ${state.effectiveMode}`];
	if (state.linkedWorktree) parts.push(state.values.worktreeMode === "off" ? "linked worktree bypass" : "linked worktree");
	parts.push(state.available ? `index ${state.readiness}` : "index tools unavailable");
	if (state.indexing) parts.push("indexing");
	if (state.pendingMutation) parts.push("index pending");
	if (state.queuedTurn) parts.push("index turn queued");
	return parts.join(" · ");
}
export function statusNotes(state: RouterSnapshot): string[] {
	const notes: string[] = [];
	if (state.issue) notes.push(`Index issue: ${state.issue}`);
	if (state.turnMayStillRun) notes.push("A queued index turn cannot be retracted and may still run.");
	return notes;
}
