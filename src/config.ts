import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalPath } from "./scope.js";

export type RouterMode = "off" | "warn" | "enforce";
export type WorktreeMode = "off" | "inherit";
export interface RouterConfig {
	mode: RouterMode;
	worktreeMode: WorktreeMode;
	autoIndex: boolean;
	autoIndexAfterWrite: boolean;
	autoIndexViaTurn: boolean;
	indexBin?: string;
	indexTimeoutMs: number;
}
export type ConfigKey = keyof RouterConfig;
export type ConfigScope = "local" | "global";
export type ConfigSource = "session" | "env" | ConfigScope | "default";
/** null removes a key from this layer, revealing the next layer. */
export type ConfigPatch = { [K in ConfigKey]?: RouterConfig[K] | null };
export type ConfigSources = Record<ConfigKey, ConfigSource>;
export interface ConfigFile {
	path: string;
	values: Partial<RouterConfig>;
	error?: string;
	ignored?: string;
}
export interface ResolvedConfig {
	values: RouterConfig;
	sources: ConfigSources;
	layers: { global: ConfigFile; local: ConfigFile; env: Partial<RouterConfig>; session: Partial<RouterConfig> };
}
export const DEFAULT_CONFIG: Readonly<RouterConfig> = Object.freeze({
	mode: "enforce", worktreeMode: "off", autoIndex: false,
	autoIndexAfterWrite: false, autoIndexViaTurn: false, indexTimeoutMs: 900_000,
});
export const CONFIG_KEYS: readonly ConfigKey[] = ["mode", "worktreeMode", "autoIndex", "autoIndexAfterWrite", "autoIndexViaTurn", "indexBin", "indexTimeoutMs"];
export const ENV_KEYS: Readonly<Record<ConfigKey, string>> = {
	mode: "PI_CODEBASE_ROUTER_MODE", worktreeMode: "PI_CODEBASE_WORKTREE_MODE",
	autoIndex: "PI_CODEBASE_AUTO_INDEX", autoIndexAfterWrite: "PI_CODEBASE_AUTO_INDEX_AFTER_WRITE",
	autoIndexViaTurn: "PI_CODEBASE_AUTO_INDEX_VIA_TURN", indexBin: "PI_CODEBASE_INDEX_BIN",
	indexTimeoutMs: "PI_CODEBASE_INDEX_TIMEOUT_MS",
};
export function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function configPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<ConfigScope, string> {
	return {
		global: join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "codebase-index", "router.json"),
		local: join(cwd, ".codebase-index", "router.json"),
	};
}
function validValue(key: ConfigKey, value: unknown): boolean {
	switch (key) {
		case "mode": return value === "off" || value === "warn" || value === "enforce";
		case "worktreeMode": return value === "off" || value === "inherit";
		case "autoIndex": case "autoIndexAfterWrite": case "autoIndexViaTurn": return typeof value === "boolean";
		case "indexBin": return typeof value === "string" && value.trim().length > 0;
		case "indexTimeoutMs": return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
	}
}
export function validatePatch(patch: ConfigPatch): void {
	for (const [key, value] of Object.entries(patch)) {
		if (!CONFIG_KEYS.includes(key as ConfigKey) || (value !== null && !validValue(key as ConfigKey, value))) {
			throw new Error(`Invalid router setting ${key}: ${JSON.stringify(value)}`);
		}
	}
}
export function applyPatch(layer: Partial<RouterConfig>, patch: ConfigPatch): Partial<RouterConfig> {
	validatePatch(patch);
	const next = { ...layer };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete next[key as ConfigKey];
		else Object.assign(next, { [key]: value });
	}
	return next;
}
function parseObject(path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
	return value as Record<string, unknown>;
}
export function readConfigFile(path: string): ConfigFile {
	const file: ConfigFile = { path, values: {} };
	try {
		if (!existsSync(path)) return file;
		const raw = parseObject(path);
		const invalid: string[] = [];
		for (const key of CONFIG_KEYS) {
			if (!(key in raw)) continue;
			if (validValue(key, raw[key])) Object.assign(file.values, { [key]: raw[key] });
			else invalid.push(key);
		}
		if (invalid.length) file.error = `Invalid settings ignored: ${invalid.join(", ")}`;
	} catch (error) { file.error = String(error); }
	return file;
}
export function envConfig(env: NodeJS.ProcessEnv): Partial<RouterConfig> {
	const values: Partial<RouterConfig> = {};
	for (const key of CONFIG_KEYS) {
		const raw = env[ENV_KEYS[key]]?.trim();
		if (!raw) continue;
		let value: unknown = raw;
		if (key === "indexTimeoutMs") value = Number(raw);
		else if (key.startsWith("autoIndex")) {
			if (/^(1|true|yes|on)$/i.test(raw)) value = true;
			else if (/^(0|false|no|off)$/i.test(raw)) value = false;
		} else if (key !== "indexBin") value = raw.toLowerCase();
		if (validValue(key, value)) Object.assign(values, { [key]: value });
	}
	return values;
}
export function resolveConfig(cwd: string, trusted: boolean, session: Partial<RouterConfig>, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
	const paths = configPaths(cwd, env);
	const global = readConfigFile(paths.global);
	const local = trusted ? readConfigFile(paths.local) : { path: paths.local, values: {}, ignored: "Project is not trusted; local router settings are ignored" };
	const layers = { global, local, env: envConfig(env), session: { ...session } };
	const values: RouterConfig = { ...DEFAULT_CONFIG };
	const sources = Object.fromEntries(CONFIG_KEYS.map((key) => [key, "default"])) as ConfigSources;
	for (const [source, layer] of [["global", global.values], ["local", local.values], ["env", layers.env], ["session", session]] as const) {
		Object.assign(values, layer);
		for (const key of CONFIG_KEYS) if (key in layer) sources[key] = source;
	}
	return { values, sources, layers };
}
/** Re-read before saving; never replace malformed/non-object data or discard unknown keys. */
export function saveConfigFile(path: string, patch: ConfigPatch): void {
	validatePatch(patch);
	// Follow dotfile-manager links, and atomically replace the target, not the link.
	const target = canonicalPath(resolve(path));
	if (!target) throw new Error(`Cannot resolve router settings path: ${path}`);
	const exists = existsSync(target);
	const mode = exists ? statSync(target).mode & 0o777 : 0o600;
	const raw = exists ? parseObject(target) : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete raw[key]; else raw[key] = value;
	}
	for (const key of CONFIG_KEYS) {
		if (key in raw && !validValue(key, raw[key])) throw new Error(`Invalid router setting ${key}`);
	}
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", mode);
		if (exists) fchmodSync(fd, mode);
		writeFileSync(fd, `${JSON.stringify(raw, null, 2)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, target);
	} finally {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch { /* renamed or not created */ }
	}
}
