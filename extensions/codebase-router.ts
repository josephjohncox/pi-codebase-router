import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * pi-codebase-router
 *
 * Index-first routing for Pi. Nudges the agent to use the
 * opencode-codebase-index semantic tools (codebase_peek / codebase_search /
 * implementation_lookup / call_graph) instead of exploratory grep and shell,
 * and keeps file reads/writes on the built-in read/edit/write tools.
 *
 * Modes (env PI_CODEBASE_ROUTER_MODE):
 *   enforce (default) - block discouraged grep/shell calls
 *   warn              - allow them but surface a status hint + inject guidance
 *   off               - passive; no prompt, no guard, no auto-index
 *
 * Optional auto-indexing (only when mode !== off):
 *   PI_CODEBASE_AUTO_INDEX=1            queue /cbindex on session start
 *   PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=1  queue /cbindex after a settled turn
 *                                         that used write/edit
 */

type Mode = "off" | "warn" | "enforce";

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

function resolveMode(): Mode {
	const value = (process.env.PI_CODEBASE_ROUTER_MODE ?? "").trim().toLowerCase();
	if (value === "off" || value === "warn" || value === "enforce") return value;
	return "enforce";
}

function envOn(name: string): boolean {
	return process.env[name] === "1";
}

function isProjectDirectory(cwd: string): boolean {
	return PROJECT_MARKERS.some((marker) => existsSync(join(cwd, marker)));
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
	let autoIndexQueued = false;
	let pendingMutation = false;

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const queueIncrementalIndex = (ctx: ExtensionContext): boolean => {
		if (autoIndexQueued || !isProjectDirectory(ctx.cwd)) return false;
		autoIndexQueued = true;
		setStatus(ctx, "codebase: incremental index queued");
		try {
			pi.sendUserMessage("/cbindex", { deliverAs: "followUp" });
			return true;
		} catch {
			autoIndexQueued = false;
			setStatus(ctx, "codebase: use /cbindex");
			return false;
		}
	};

	pi.on("session_start", (event, ctx) => {
		const mode = resolveMode();
		if (mode === "off") {
			setStatus(ctx, "codebase-router: off");
			return;
		}

		const toolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		const indexed =
			toolNames.has("codebase_peek") && toolNames.has("codebase_search");
		setStatus(
			ctx,
			indexed
				? `codebase-router: ${mode} · /cbindex if missing`
				: "codebase-router: index tools unavailable (install opencode-codebase-index)",
		);

		if (
			indexed &&
			envOn("PI_CODEBASE_AUTO_INDEX") &&
			AUTO_INDEX_SESSION_REASONS.has(event.reason)
		) {
			queueIncrementalIndex(ctx);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (resolveMode() === "off") return;
		if (!CODE_TASK_PATTERN.test(event.prompt)) return;
		return { systemPrompt: `${event.systemPrompt}\n${ROUTING_INSTRUCTIONS}` };
	});

	pi.on("tool_call", (event, ctx) => {
		const mode = resolveMode();
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
		if (resolveMode() === "off") return;

		if (event.toolName === "index_codebase") {
			autoIndexQueued = false;
			pendingMutation = false;
			setStatus(ctx, "codebase-router: index current");
			return;
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			if (envOn("PI_CODEBASE_AUTO_INDEX_AFTER_WRITE")) pendingMutation = true;
			return;
		}

		if (!INDEX_TOOLS.test(event.toolName)) return;
		indexedCalls += 1;
		setStatus(ctx, `codebase-router: index-first · searches ${indexedCalls}`);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (resolveMode() === "off") return;
		if (
			envOn("PI_CODEBASE_AUTO_INDEX_AFTER_WRITE") &&
			pendingMutation &&
			queueIncrementalIndex(ctx)
		) {
			pendingMutation = false;
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		setStatus(ctx, undefined);
		blockedCount = 0;
		indexedCalls = 0;
		autoIndexQueued = false;
		pendingMutation = false;
	});
}
