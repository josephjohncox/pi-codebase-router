import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BackgroundIndexer, resolveIndexLauncher } from "./background.js";
import { applyPatch, asRecord, CONFIG_KEYS, configPaths, resolveConfig, saveConfigFile, type ConfigKey, type ConfigPatch, type ConfigScope, type ResolvedConfig, type RouterConfig, type RouterMode } from "./config.js";
import { readinessFailure, resultFailure, retrievalReadinessFailure, statusIsReady } from "./results.js";
import { classifyBash, classifyGrep, CODE_TASK_PATTERN, INDEX_TOOLS, ROUTING_INSTRUCTIONS } from "./routing.js";
import { inspectProject, isScopedPath, type ProjectScope } from "./scope.js";

const STATUS_KEY = "codebase-router";
const PROMPT_SECTION_KEY = "codebase_router";
const SESSION_ENTRY = "codebase-router:settings";
const USAGE = "Usage: /cbrouter [local|global] off|on|toggle|warn|enforce|status|reset, or /cbrouter settings [global|local]";
export interface RouterSnapshot extends ResolvedConfig {
	effectiveMode: RouterMode;
	linkedWorktree: boolean;
	available: boolean;
	readiness: "unknown" | "ready" | "degraded";
	issue?: string;
	indexing: boolean;
	pendingMutation: boolean;
	queuedTurn: boolean;
	/** Pi cannot retract an already queued opt-in agent follow-up. */
	turnMayStillRun: boolean;
	counters: { blocked: number; indexedCalls: number; context: number; editContext: number; architecture: number };
}
/** The settings UI must use these methods rather than reimplement precedence or writes. */
export interface RouterController {
	snapshot(ctx: ExtensionContext): RouterSnapshot;
	setSession(ctx: ExtensionContext, patch: ConfigPatch): RouterSnapshot;
	clearSession(ctx: ExtensionContext, keys?: readonly ConfigKey[]): RouterSnapshot;
	save(ctx: ExtensionContext, scope: ConfigScope, patch: ConfigPatch): RouterSnapshot;
	reload(ctx: ExtensionContext): RouterSnapshot;
}
export interface RouterOptions {
	agentDir: string;
	projectConfigDir: string;
	/** Tests can supply an isolated environment without touching live config. */
	env?: NodeJS.ProcessEnv;
	/** UI layer owns all dialogs and handles /cbrouter and /cbrouter settings|config [global|local]. */
	openSettings?: (controller: RouterController, ctx: ExtensionContext, scope?: ConfigScope) => Promise<void>;
}
interface CapturedCall { toolName: string; input: Record<string, unknown>; cwd: string; scopedMutation: boolean; }
export function registerCodebaseRouter(pi: ExtensionAPI, options: RouterOptions): RouterController {
	let session: Partial<RouterConfig> = {};
	let live = false;
	let pendingMutation = false, dirty = false, followUpQueued = false, turnMayStillRun = false;
	let readiness: RouterSnapshot["readiness"] = "unknown";
	let issue: string | undefined;
	let projectCwd: string | undefined;
	let project: ProjectScope = { project: false, linkedWorktree: false };
	let counters: RouterSnapshot["counters"] = { blocked: 0, indexedCalls: 0, context: 0, editContext: 0, architecture: 0 };
	const calls = new Map<string, CapturedCall>();
	const canceledCalls = new Set<string>();
	const background = new BackgroundIndexer();
	const env = () => options.env ?? process.env;
	const tools = () => {
		const active = new Set(pi.getActiveTools());
		return new Set(pi.getAllTools().filter((tool) => tool.exposure !== "hidden" && (active.has(tool.name) || tool.exposure === "codemode" || tool.exposure === "deferred")).map((tool) => tool.name));
	};
	const cancel = () => {
		pendingMutation = false;
		dirty = false;
		turnMayStillRun ||= followUpQueued;
		followUpQueued = false;
		for (const id of calls.keys()) canceledCalls.add(id);
		calls.clear();
		background.cancel();
	};
	const snapshot = (ctx: ExtensionContext): RouterSnapshot => {
		if (projectCwd !== ctx.cwd) {
			cancel();
			projectCwd = ctx.cwd;
			project = inspectProject(ctx.cwd);
			readiness = "unknown";
			issue = undefined;
		}
		const resolved = resolveConfig(ctx.cwd, ctx.isProjectTrusted(), session, env());
		const names = tools();
		const available = names.has("index_status") && [...INDEX_TOOLS].some((name) => names.has(name));
		const effectiveMode = project.linkedWorktree && resolved.values.worktreeMode === "off" ? "off" : resolved.values.mode;
		if (effectiveMode === "off") cancel();
		return { ...resolved, effectiveMode, linkedWorktree: project.linkedWorktree, available, readiness, issue,
			indexing: background.running, pendingMutation, queuedTurn: followUpQueued, turnMayStillRun, counters: { ...counters } };
	};
	const status = (ctx: ExtensionContext, text: string | undefined) => { if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text); };
	const refreshStatus = (ctx: ExtensionContext): RouterSnapshot => {
		const state = snapshot(ctx);
		status(ctx, state.effectiveMode === "off"
			? `codebase-router: off${state.linkedWorktree && state.values.worktreeMode === "off" ? " (linked worktree)" : ""}`
			: !state.available ? "codebase-router: index tools unavailable (fallback allowed)"
			: `codebase-router: ${state.values.mode}${state.issue ? ` · ${state.issue}` : " · index_status for readiness"}`);
		return state;
	};
	const restore = (ctx: ExtensionContext) => {
		session = {};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY) continue;
			const data = asRecord(entry.data);
			if (data.version !== 1 || data.sessionId !== ctx.sessionManager.getSessionId()) continue;
			try { session = applyPatch({}, asRecord(data.overrides) as ConfigPatch); } catch { /* invalid persisted state is ignored */ }
		}
	};
	const controller: RouterController = {
		snapshot,
		setSession(ctx, patch) {
			const next = applyPatch(session, patch);
			// Append before publishing the in-memory change so persistence errors surface.
			pi.appendEntry(SESSION_ENTRY, { version: 1, sessionId: ctx.sessionManager.getSessionId(), overrides: next });
			session = next;
			return refreshStatus(ctx);
		},
		clearSession(ctx, keys = CONFIG_KEYS) {
			return controller.setSession(ctx, Object.fromEntries(keys.map((key) => [key, null])) as ConfigPatch);
		},
		save(ctx, scope, patch) {
			if (scope === "local" && !ctx.isProjectTrusted()) throw new Error("Project is not trusted; local router settings cannot be saved");
			saveConfigFile(configPaths(ctx.cwd, env())[scope], patch);
			return refreshStatus(ctx);
		},
		reload(ctx) {
			if (projectCwd === ctx.cwd) project = inspectProject(ctx.cwd);
			return refreshStatus(ctx);
		},
	};
	const requestIndex = (ctx: ExtensionContext): void => {
		const state = snapshot(ctx);
		if (!live || state.effectiveMode === "off" || !state.available || !project.project) return;
		if (background.running) { dirty = true; return; }
		if (state.values.autoIndexViaTurn) {
			if (followUpQueued || !tools().has("index_codebase")) return;
			followUpQueued = true;
			try {
				pi.sendUserMessage("Refresh the index for this cwd with index_codebase({ force: false }). Do not force a rebuild.", { deliverAs: "followUp" });
				status(ctx, "codebase-router: incremental index queued (agent turn)");
			} catch (error) {
				followUpQueued = false;
				status(ctx, `codebase-router: cannot queue index: ${error}`);
			}
			return;
		}
		const launcher = resolveIndexLauncher(ctx.cwd, state.values, options.agentDir, options.projectConfigDir, ctx.isProjectTrusted());
		if (!launcher) { status(ctx, "codebase-router: index CLI unavailable; use /cbindex (no automatic turn/install)"); return; }
		dirty = false;
		status(ctx, "codebase-router: indexing… (background)");
		background.start(ctx.cwd, launcher, state.values.indexTimeoutMs, (outcome) => {
			const current = snapshot(ctx);
			if (!live || current.effectiveMode === "off") return;
			const rerun = dirty;
			dirty = false;
			readiness = outcome.success ? "ready" : "degraded";
			issue = outcome.success ? undefined : outcome.message;
			status(ctx, `codebase-router: ${outcome.message}`);
			// Failed calls never churn through queued retries.
			if (outcome.success && rerun && (current.values.autoIndex || current.values.autoIndexAfterWrite)) requestIndex(ctx);
		});
	};
	const notify = (ctx: ExtensionContext, text: string, kind: "info" | "error" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(text, kind);
		else if (ctx.mode === "print") console.log(text);
		else pi.sendMessage({ customType: "codebase-router:status", content: text, display: true }, { triggerTurn: false });
	};
	pi.registerCommand("cbrouter", {
		description: "Router off/on/toggle/warn/enforce/status/reset; local/global persistent mode; settings",
		getArgumentCompletions(prefix) {
			const items = ["off", "on", "toggle", "warn", "enforce", "status", "reset", "local", "global", "settings", "config"].filter((value) => value.startsWith(prefix));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		async handler(args, ctx) {
			try {
				const words = args.trim().split(/\s+/).filter(Boolean);
				const settingsScope = words[1] === "global" || words[1] === "local" ? words[1] : undefined;
				if (options.openSettings && (words.length === 0 || ((words[0] === "settings" || words[0] === "config") && (words.length === 1 || (words.length === 2 && settingsScope))))) {
					await options.openSettings(controller, ctx, settingsScope);
					return;
				}
				let scope: ConfigScope | undefined;
				if (words[0] === "local" || words[0] === "global") scope = words.shift() as ConfigScope;
				const action = words.shift() ?? "status";
				if (words.length) throw new Error(USAGE);
				let state = snapshot(ctx);
				if (action === "reset") {
					state = scope ? controller.save(ctx, scope, { mode: null }) : controller.clearSession(ctx);
				} else if (["off", "on", "toggle", "warn", "enforce"].includes(action)) {
					const mode = action === "on" ? "enforce" : action === "toggle" ? state.values.mode === "off" ? "enforce" : "off" : action as RouterMode;
					state = scope ? controller.save(ctx, scope, { mode }) : controller.setSession(ctx, { mode });
				} else if (action !== "status") throw new Error(USAGE);
				const lines = CONFIG_KEYS.map((key) => `${key}: ${JSON.stringify(state.values[key]) ?? "auto"} [${state.sources[key]}]`);
				const diagnostics = [state.layers.global.error, state.layers.local.error, state.layers.local.ignored, state.issue,
					state.turnMayStillRun ? "An already queued opt-in agent follow-up cannot be retracted and may still run after off." : undefined].filter(Boolean);
				notify(ctx, [`Router effective mode: ${state.effectiveMode}${state.linkedWorktree ? " (linked worktree)" : ""}`, ...lines, ...diagnostics].join("\n"));
			} catch (error) {
				if (!ctx.hasUI) throw error;
				notify(ctx, `Router settings failed: ${error}`, "error");
			}
		},
	});
	pi.on("session_start", (event, ctx) => {
		live = true;
		projectCwd = undefined;
		restore(ctx);
		const state = refreshStatus(ctx);
		if (state.values.autoIndex && ["startup", "new", "resume", "fork"].includes(event.reason)) requestIndex(ctx);
	});
	pi.on("session_tree", (_event, ctx) => { cancel(); restore(ctx); refreshStatus(ctx); });
	pi.on("before_agent_start", (event, ctx) => {
		// A queued legacy follow-up is now consumed (or superseded by another run).
		followUpQueued = false;
		turnMayStillRun = false;
		// Own one section so Pi can patch it without replacing the cached prompt prefix.
		delete event.systemPromptOptions.sections[PROMPT_SECTION_KEY];
		const state = snapshot(ctx);
		if (!live || state.effectiveMode === "off" || !state.available || event.messageType !== "user" || !CODE_TASK_PATTERN.test(event.prompt)) return;
		event.systemPromptOptions.sections[PROMPT_SECTION_KEY] = state.readiness === "degraded"
			? "Index unavailable: check index_status for diagnostics. Direct tools and known-file fallback are allowed; do not require indexed evidence."
			: ROUTING_INSTRUCTIONS.trim();
	});
	pi.on("tool_call", (event, ctx) => {
		const state = snapshot(ctx);
		if (!live || state.effectiveMode === "off") return;
		const input = asRecord(event.input);
		// Finalization events have no input. Capture by ID, including nested/parallel calls.
		if (["write", "edit", "index_codebase", "index_status"].includes(event.toolName) || INDEX_TOOLS.has(event.toolName)) {
			calls.set(event.toolCallId, { toolName: event.toolName, input, cwd: ctx.cwd, scopedMutation: isScopedPath(ctx.cwd, input.path) });
		}
		if (["read", "edit", "write"].includes(event.toolName) || !state.available || state.readiness === "degraded") return;
		const hit = event.toolName === "grep" ? classifyGrep(ctx.cwd, input)
			: event.toolName === "bash" && typeof input.command === "string" ? classifyBash(ctx.cwd, input.command) : undefined;
		if (!hit) return;
		const names = tools();
		if (hit.kind === "read" && !names.has("read") || hit.kind === "write" && !names.has("edit") && !names.has("write")) return;
		if (state.effectiveMode === "enforce") {
			counters.blocked++;
			status(ctx, `codebase-router: blocked ${hit.kind} (${counters.blocked})`);
			return { block: true, reason: hit.reason };
		}
		status(ctx, `codebase-router: prefer index (${hit.kind}; warn only)`);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "index_codebase") { followUpQueued = false; turnMayStillRun = false; }
		if (canceledCalls.delete(event.toolCallId)) return;
		const captured = calls.get(event.toolCallId);
		calls.delete(event.toolCallId);
		const state = snapshot(ctx);
		if (!live || state.effectiveMode === "off") return;
		if (event.toolName === "write" || event.toolName === "edit") {
			if (state.values.autoIndexAfterWrite && !resultFailure(event.result, event.isError) && captured?.toolName === event.toolName && captured.cwd === ctx.cwd && captured.scopedMutation && isScopedPath(ctx.cwd, captured.input.path)) pendingMutation = true;
			return;
		}
		if (event.toolName === "index_codebase" || event.toolName === "index_status" || INDEX_TOOLS.has(event.toolName)) {
			const retrieval = INDEX_TOOLS.has(event.toolName);
			const failure = retrieval ? retrievalReadinessFailure(event.result, event.isError) : readinessFailure(event.result, event.isError);
			if (failure) { readiness = "degraded"; issue = failure; status(ctx, "codebase-router: index unavailable (fallback allowed)"); return; }
			if (retrieval && resultFailure(event.result, event.isError)) {
				status(ctx, "codebase-router: query failed; check index_status if needed");
				return;
			}
			if (event.toolName === "index_status") {
				if (statusIsReady(event.result)) { readiness = "ready"; issue = undefined; }
				refreshStatus(ctx);
				return;
			}
			if (event.toolName === "index_codebase") {
				if (!captured || captured.input.estimateOnly === true || captured.input.dryRun === true) return;
				if (!Array.isArray(asRecord(event.result).content) || (asRecord(event.result).content as unknown[]).length === 0) {
					readiness = "degraded"; issue = "index returned no result"; refreshStatus(ctx); return;
				}
				readiness = "ready"; issue = undefined;
				status(ctx, "codebase-router: index refreshed");
				return;
			}
			counters.indexedCalls++;
			if (event.toolName === "codebase_context") counters.context++;
			if (event.toolName === "codebase_edit_context") counters.editContext++;
			if (event.toolName === "architecture_context") counters.architecture++;
			status(ctx, `codebase-router: index-first · calls ${counters.indexedCalls}`);
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		// Finalized calls can no longer arrive after the settled boundary.
		canceledCalls.clear();
		const state = snapshot(ctx);
		if (state.values.autoIndexAfterWrite && pendingMutation) { pendingMutation = false; requestIndex(ctx); }
	});
	pi.on("session_shutdown", (_event, ctx) => {
		live = false;
		cancel();
		status(ctx, undefined);
		counters = { blocked: 0, indexedCalls: 0, context: 0, editContext: 0, architecture: 0 };
	});
	return controller;
}
