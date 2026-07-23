import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi-codebase-router
 *
 * Index-first routing for Pi. Nudges the agent to use the
 * opencode-codebase-index semantic tools (codebase_peek / codebase_search /
 * implementation_lookup / call_graph) instead of exploratory grep and shell,
 * and keeps file reads/writes on the built-in read/edit/write tools.
 *
 * Configuration (precedence: env var > project router.json > global
 * router.json > default):
 *   global  router.json: $XDG_CONFIG_HOME/codebase-index/router.json
 *                        (default ~/.config/codebase-index/router.json)
 *   project router.json: <cwd>/.codebase-index/router.json
 *
 *   router.json keys      env override                         values
 *   --------------------  -----------------------------------  ---------------
 *   mode                  PI_CODEBASE_ROUTER_MODE              off|warn|enforce
 *   autoIndex             PI_CODEBASE_AUTO_INDEX               bool
 *   autoIndexAfterWrite   PI_CODEBASE_AUTO_INDEX_AFTER_WRITE   bool
 *   autoIndexViaTurn      PI_CODEBASE_AUTO_INDEX_VIA_TURN      bool
 *   indexBin              PI_CODEBASE_INDEX_BIN                path to cli.js
 *   indexTimeoutMs        PI_CODEBASE_INDEX_TIMEOUT_MS         positive int
 *
 * Env booleans: "1"/"true"/"yes"/"on" = true, "0"/"false"/"no"/"off" = false,
 * anything else / unset = no override.
 *
 * Background auto-indexing runs opencode-codebase-index as a detached MCP
 * subprocess (host "pi") — no agent turn, no LLM cost, non-blocking.
 */

type Mode = "off" | "warn" | "enforce";

interface RouterConfig {
	mode: Mode;
	autoIndex: boolean;
	autoIndexAfterWrite: boolean;
	autoIndexViaTurn: boolean;
	indexBin?: string;
	indexTimeoutMs: number;
}

const DEFAULT_CONFIG: RouterConfig = {
	mode: "enforce",
	autoIndex: false,
	autoIndexAfterWrite: false,
	autoIndexViaTurn: false,
	indexTimeoutMs: 15 * 60 * 1000,
};

const STATUS_KEY = "codebase-router";

const CODE_TASK_PATTERN =
	/\b(code|codebase|repo|repository|file|function|class|method|module|package|bug|fix|refactor|implement|test|build|compile|api|library|dependency|hook|extension|config|configuration|source|stack trace|error)\b/i;

const ROUTING_INSTRUCTIONS = `
## Indexed-codebase routing
For repository and code tasks, prefer the local codebase index over exploratory shell searches:
- Unknown behavior, concept, or symbol: use codebase_peek first (small limit, metadata only).
- Need the definition: use implementation_lookup; need code after locating it: use read on the returned file and lines.
- Need callers, callees, or blast radius: use call_graph, call_graph_path, or pr_impact after locating symbols.
- Use codebase_search only when the actual indexed code context is needed; keep results narrow with limit, fileType, directory, chunkType, and contextLines=0.
- Use grep only for an exact known identifier, literal, or exhaustive occurrence check. Do not grep for concepts such as “where is auth handled?”
- Use the built-in read, edit, and write tools for file access and mutations; do not use shell cat/sed/tee/redirection for source edits.
- If the index is missing or stale, use /cbindex (or the index_codebase tool). Use force only for a full rebuild or provider/model incompatibility.
`;

const GREP_REASON =
	"Use the indexed-codebase workflow first: codebase_peek for locations, implementation_lookup for definitions, then read. Reserve grep for exact identifiers/literals or exhaustive matches.";
const READ_REASON =
	"Use the built-in read tool for file contents. Use codebase_peek/codebase_search for discovery instead of cat, head, tail, or sed.";
const WRITE_REASON =
	"Use the built-in edit or write tool for source mutations. Shell redirection, tee, sed -i, and perl -i are blocked to preserve precise diffs and mutation ordering.";

const INDEX_TOOLS =
	/^(?:codebase_peek|codebase_search|implementation_lookup|call_graph|call_graph_path|pr_impact)$/;

// Must match opencode-codebase-index's Pi host so the background index writes
// to the same directory Pi's in-process codebase_search reads.
const INDEX_HOST = "pi";

const AUTO_INDEX_SESSION_REASONS = new Set(["startup", "new", "resume", "fork"]);
const PROJECT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
];
const TOOLCHAIN_PATTERN =
	/\b(?:git|npm|pnpm|yarn|bun|cargo|pytest|vitest|jest|make|go|deno)\b/;

// ---------------------------------------------------------------------------
// Configuration (router.json + env)
// ---------------------------------------------------------------------------

function xdgConfigHome(): string {
	const value = process.env.XDG_CONFIG_HOME;
	return value && value.trim() ? value : join(homedir(), ".config");
}

/** [global, project] router.json paths; project overrides global. */
function routerConfigPaths(cwd: string): [string, string] {
	return [
		join(xdgConfigHome(), "codebase-index", "router.json"),
		join(cwd, ".codebase-index", "router.json"),
	];
}

function coerceMode(value: unknown): Mode | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim().toLowerCase();
	return v === "off" || v === "warn" || v === "enforce" ? v : undefined;
}

function coerceFileBool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function coerceEnvBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(v)) return true;
	if (["0", "false", "no", "off"].includes(v)) return false;
	return undefined;
}

function readRouterFile(path: string): Partial<RouterConfig> {
	let raw: Record<string, unknown>;
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return {};
		raw = parsed as Record<string, unknown>;
	} catch {
		return {};
	}
	const layer: Partial<RouterConfig> = {};
	const mode = coerceMode(raw.mode);
	if (mode) layer.mode = mode;
	const autoIndex = coerceFileBool(raw.autoIndex);
	if (autoIndex !== undefined) layer.autoIndex = autoIndex;
	const afterWrite = coerceFileBool(raw.autoIndexAfterWrite);
	if (afterWrite !== undefined) layer.autoIndexAfterWrite = afterWrite;
	const viaTurn = coerceFileBool(raw.autoIndexViaTurn);
	if (viaTurn !== undefined) layer.autoIndexViaTurn = viaTurn;
	if (typeof raw.indexBin === "string" && raw.indexBin.trim()) {
		layer.indexBin = raw.indexBin.trim();
	}
	if (typeof raw.indexTimeoutMs === "number" && raw.indexTimeoutMs > 0) {
		layer.indexTimeoutMs = raw.indexTimeoutMs;
	}
	return layer;
}

function envLayer(): Partial<RouterConfig> {
	const layer: Partial<RouterConfig> = {};
	const mode = coerceMode(process.env.PI_CODEBASE_ROUTER_MODE);
	if (mode) layer.mode = mode;
	const autoIndex = coerceEnvBool(process.env.PI_CODEBASE_AUTO_INDEX);
	if (autoIndex !== undefined) layer.autoIndex = autoIndex;
	const afterWrite = coerceEnvBool(process.env.PI_CODEBASE_AUTO_INDEX_AFTER_WRITE);
	if (afterWrite !== undefined) layer.autoIndexAfterWrite = afterWrite;
	const viaTurn = coerceEnvBool(process.env.PI_CODEBASE_AUTO_INDEX_VIA_TURN);
	if (viaTurn !== undefined) layer.autoIndexViaTurn = viaTurn;
	const bin = process.env.PI_CODEBASE_INDEX_BIN;
	if (bin && bin.trim()) layer.indexBin = bin.trim();
	const timeout = Number(process.env.PI_CODEBASE_INDEX_TIMEOUT_MS);
	if (Number.isFinite(timeout) && timeout > 0) layer.indexTimeoutMs = timeout;
	return layer;
}

function isProjectDirectory(cwd: string): boolean {
	return PROJECT_MARKERS.some((marker) => existsSync(join(cwd, marker)));
}

/**
 * Locate the opencode-codebase-index CLI (an MCP server). Returns argv to launch
 * it via Node, or null to fall back to `npx`.
 */
function resolveIndexLauncher(
	cwd: string,
	indexBin: string | undefined,
): { cmd: string; args: string[] } | null {
	const rel = join(
		"npm",
		"node_modules",
		"opencode-codebase-index",
		"dist",
		"cli.js",
	);
	const candidates = [indexBin, join(getAgentDir(), rel), join(cwd, CONFIG_DIR_NAME, rel)].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { cmd: process.execPath, args: [candidate] };
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/**
 * An "exact" lookup is a good fit for grep: a single token that looks like a
 * concrete identifier/literal (has case, punctuation, or is very short) rather
 * than a natural-language phrase.
 */
function isLikelyExactLookup(pattern: string, literal: boolean): boolean {
	if (literal) return true;
	const value = pattern.trim();
	if (!value) return true;
	if (/\s/.test(value)) return false;
	if (value.length <= 2) return true;
	return (
		/[A-Z]/.test(value) ||
		/[_.:$\\/\\-]/.test(value) ||
		/^(?:TODO|FIXME|HACK|XXX)$/i.test(value) ||
		/^[a-z]+\d+$/.test(value)
	);
}

/** Remove redirects that are not file writes (fd dups and /dev/null|stdout|stderr). */
function stripHarmlessRedirects(command: string): string {
	return command
		.replace(/\d*>>?\s*\/dev\/(?:null|stdout|stderr)\b/g, " ")
		.replace(/&>>?\s*\/dev\/(?:null|stdout|stderr)\b/g, " ")
		.replace(/\d*>&\d*/g, " ");
}

/** True when the command redirects into a real file (a source-write risk). */
function hasFileWriteRedirect(command: string): boolean {
	const cleaned = stripHarmlessRedirects(command);
	return /(?:^|\s)(?:\d*>>?|&>>?)\s*[^\s&|]/.test(cleaned);
}

function extractShellSearch(
	command: string,
): { pattern: string; literal: boolean } | undefined {
	if (TOOLCHAIN_PATTERN.test(command)) return undefined;
	const match = command.match(/\b(?:rg|grep)\b(?<args>[^;&|]*)/);
	if (!match?.groups?.args) return undefined;

	const args = match.groups.args;
	const literal = /(?:^|\s)(?:-F|--fixed-strings)(?:\s|$)/.test(args);
	const quoted = args.match(/(?:^|\s)(?:-[A-Za-z]+\s+)*(["'])(.*?)\1/);
	if (quoted) return { pattern: quoted[2], literal };

	const words = args.trim().split(/\s+/).filter(Boolean);
	const pattern = words.find((word) => !word.startsWith("-"));
	return pattern ? { pattern, literal } : undefined;
}

function isShellSourceRead(command: string): boolean {
	const stripped = stripHarmlessRedirects(command).trim();
	if (/[|;&]/.test(stripped) || TOOLCHAIN_PATTERN.test(stripped)) return false;
	if (!/^(?:cat|head|tail|less|more|sed)\b/.test(stripped)) return false;
	if (hasFileWriteRedirect(command)) return false; // handled as a write
	return true;
}

function isShellSourceWrite(command: string): boolean {
	const trimmed = command.trim();
	if (/^(?:sed|perl)\b[^\n]*\s-i(?:\b|\s|$)/.test(trimmed)) return true; // in-place
	if (/^tee\b\s+[^-\s]/.test(trimmed)) return true; // tee <file>
	if (/\|\s*tee\b\s+[^-\s]/.test(stripHarmlessRedirects(trimmed))) return true;
	if (!/^(?:cat|printf|echo|tee)\b/.test(trimmed)) return false;
	return hasFileWriteRedirect(trimmed);
}

type Classification = { kind: string; reason: string } | null;

function classifyBashCommand(command: string): Classification {
	const search = extractShellSearch(command);
	if (search && !isLikelyExactLookup(search.pattern, search.literal)) {
		return { kind: "search", reason: GREP_REASON };
	}
	if (isShellSourceRead(command)) return { kind: "read", reason: READ_REASON };
	if (isShellSourceWrite(command)) return { kind: "write", reason: WRITE_REASON };
	return null;
}

export default function codebaseRouterExtension(pi: ExtensionAPI) {
	let blockedCount = 0;
	let indexedCalls = 0;
	let pendingMutation = false;

	// Background-index lifecycle state.
	let indexChild: ChildProcess | null = null;
	let indexing = false;
	let dirty = false;
	let followUpQueued = false;

	// Cached file-config layer, invalidated on each session_start (so editing
	// router.json takes effect on /reload or a new session). Env is read live.
	let fileLayerCwd: string | undefined;
	let fileLayer: Partial<RouterConfig> = {};

	const config = (cwd: string): RouterConfig => {
		if (cwd !== fileLayerCwd) {
			const [globalPath, projectPath] = routerConfigPaths(cwd);
			fileLayer = { ...readRouterFile(globalPath), ...readRouterFile(projectPath) };
			fileLayerCwd = cwd;
		}
		return { ...DEFAULT_CONFIG, ...fileLayer, ...envLayer() };
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	/** Legacy path: ask the agent to run /cbindex on a follow-up turn. */
	const queueFollowUpIndex = (ctx: ExtensionContext): void => {
		if (followUpQueued) return;
		followUpQueued = true;
		setStatus(ctx, "codebase: /cbindex queued (turn)");
		try {
			pi.sendUserMessage("/cbindex", { deliverAs: "followUp" });
		} catch {
			followUpQueued = false;
			setStatus(ctx, "codebase: use /cbindex");
		}
	};

	/**
	 * Background path: drive one index_codebase call over MCP stdio against a
	 * detached opencode-codebase-index server, then let it exit. No agent turn.
	 */
	const runBackgroundIndex = (ctx: ExtensionContext, cfg: RouterConfig): void => {
		if (!isProjectDirectory(ctx.cwd)) return;
		if (indexing) {
			dirty = true;
			return;
		}
		if (cfg.autoIndexViaTurn) {
			queueFollowUpIndex(ctx);
			return;
		}

		const launcher = resolveIndexLauncher(ctx.cwd, cfg.indexBin);
		const cmd = launcher?.cmd ?? "npx";
		const args = launcher
			? [...launcher.args, "--project", ctx.cwd, "--host", INDEX_HOST]
			: [
					"-y",
					"--package",
					"opencode-codebase-index",
					"opencode-codebase-index-mcp",
					"--project",
					ctx.cwd,
					"--host",
					INDEX_HOST,
				];

		let child: ChildProcess;
		try {
			child = spawn(cmd, args, {
				cwd: ctx.cwd,
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			queueFollowUpIndex(ctx); // fall back to the turn-based path
			return;
		}

		indexing = true;
		dirty = false;
		indexChild = child;
		setStatus(ctx, "codebase: indexing… (background)");

		let settled = false;
		let started = false;
		let buffer = "";
		const send = (message: unknown) => {
			try {
				child.stdin?.write(`${JSON.stringify(message)}\n`);
			} catch {
				/* server gone; exit handler cleans up */
			}
		};
		const stop = () => {
			if (settled) return;
			settled = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		};
		const timer = setTimeout(() => {
			setStatus(ctx, "codebase: index timed out");
			stop();
		}, cfg.indexTimeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			started = true;
			buffer += chunk.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let message: { id?: number; result?: unknown; error?: unknown };
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id === 1 && message.result) {
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					send({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "index_codebase", arguments: {} },
					});
				} else if (message.id === 2) {
					setStatus(
						ctx,
						message.error
							? "codebase: index error"
							: "codebase: index refreshed (background)",
					);
					stop();
				}
			}
		});

		child.on("error", () => {
			clearTimeout(timer);
			indexing = false;
			indexChild = null;
			if (!started) queueFollowUpIndex(ctx); // launcher missing → turn fallback
		});

		child.on("exit", () => {
			clearTimeout(timer);
			indexing = false;
			indexChild = null;
			const wasDirty = dirty;
			dirty = false;
			if (wasDirty) runBackgroundIndex(ctx, config(ctx.cwd)); // coalesced re-run
		});

		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "pi-codebase-router", version: "0.3.0" },
			},
		});
	};

	pi.on("session_start", (event, ctx) => {
		fileLayerCwd = undefined; // re-read router.json this session
		const cfg = config(ctx.cwd);
		if (cfg.mode === "off") {
			setStatus(ctx, "codebase-router: off");
			return;
		}

		const toolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		const indexed =
			toolNames.has("codebase_peek") && toolNames.has("codebase_search");
		setStatus(
			ctx,
			indexed
				? `codebase-router: ${cfg.mode} · /cbindex if missing`
				: "codebase-router: index tools unavailable — pi install npm:opencode-codebase-index",
		);

		if (
			indexed &&
			cfg.autoIndex &&
			AUTO_INDEX_SESSION_REASONS.has(event.reason)
		) {
			runBackgroundIndex(ctx, cfg);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (config(ctx.cwd).mode === "off") return;
		if (!CODE_TASK_PATTERN.test(event.prompt)) return;
		return { systemPrompt: `${event.systemPrompt}\n${ROUTING_INSTRUCTIONS}` };
	});

	pi.on("tool_call", (event, ctx) => {
		const mode = config(ctx.cwd).mode;
		if (mode === "off") return;

		const input = asRecord(event.input);
		let hit: Classification = null;

		if (event.toolName === "grep") {
			const pattern = typeof input.pattern === "string" ? input.pattern : "";
			const literal = input.literal === true;
			if (!isLikelyExactLookup(pattern, literal)) {
				hit = { kind: "search", reason: GREP_REASON };
			}
		} else if (event.toolName === "bash" && typeof input.command === "string") {
			hit = classifyBashCommand(input.command);
		}

		if (!hit) return;

		if (mode === "enforce") {
			blockedCount += 1;
			setStatus(ctx, `codebase-router: blocked ${hit.kind} (${blockedCount})`);
			return { block: true, reason: hit.reason };
		}

		// warn mode: allow, but nudge.
		setStatus(ctx, `codebase-router: prefer index (${hit.kind})`);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const cfg = config(ctx.cwd);
		if (cfg.mode === "off") return;

		if (event.toolName === "index_codebase") {
			followUpQueued = false;
			pendingMutation = false;
			setStatus(ctx, "codebase-router: index current");
			return;
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			if (cfg.autoIndexAfterWrite) pendingMutation = true;
			return;
		}

		if (!INDEX_TOOLS.test(event.toolName)) return;
		indexedCalls += 1;
		setStatus(ctx, `codebase-router: index-first · searches ${indexedCalls}`);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const cfg = config(ctx.cwd);
		if (cfg.mode === "off") return;
		if (cfg.autoIndexAfterWrite && pendingMutation) {
			pendingMutation = false;
			runBackgroundIndex(ctx, cfg);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		setStatus(ctx, undefined);
		if (indexChild) {
			try {
				indexChild.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			indexChild = null;
		}
		blockedCount = 0;
		indexedCalls = 0;
		pendingMutation = false;
		indexing = false;
		dirty = false;
		followUpQueued = false;
	});
}
