import { hasParentTraversal, isScopedPath } from "./scope.js";

export const INDEX_TOOLS = new Set(["codebase_context", "codebase_edit_context", "architecture_context", "code_communities", "codebase_peek", "codebase_search", "find_similar", "implementation_lookup", "call_graph", "call_graph_path", "pr_impact"]);
export const CODE_TASK_PATTERN = /\b(code|codebase|repo|repository|file|function|class|method|module|package|bug|fix|refactor|implement|test|build|compile|api|library|dependency|hook|extension|config|configuration|source|stack trace|error)\b/i;
export const ROUTING_INSTRUCTIONS = `
## Indexed-codebase routing
This is a workflow router, not a security boundary. Guidance applies only to the indexed cwd, not outside paths or sibling worktrees. Built-in read/edit/write are always allowed.
- Check index_status when readiness is unknown. If missing, incompatible, migrating, or retrieval fails, use direct tools/known-file fallback; do not get stuck. Use incremental index_codebase({ force: false }) for normal updates and storage migrations; force only for an explicitly requested full rebuild or provider/model incompatibility.
- For unfamiliar repository/subsystem orientation, optionally request codebase_context with tokenBudget: 600, limit: 5. Inspect that evidence before broad reads. No mandatory peek/context chain.
- Use implementation_lookup directly for known definitions; read the returned file/lines only as needed. Use call_graph for callers/callees and call_graph_path for identified endpoints; pr_impact for blast radius.
- Optionally use codebase_edit_context for bounded pre-edit evidence around a known or suspected target. architecture_context can map repository-scale structure.
- codebase_peek is optional metadata-only discovery; codebase_search is for semantic source matches. Keep filters/limits narrow and do not remove directory scope to recover a miss.
- Reserve grep for exact known identifiers/literals or exhaustive occurrence checks. Prefer built-in read/edit/write over shell source reads/writes.
`;
export interface Classification { kind: "search" | "read" | "write"; reason: string; }
const SEARCH_REASON = "Prefer the index for conceptual discovery: check index_status if readiness is unknown; use compact codebase_context for orientation or lookup/search directly. Exact identifiers/literals and known-file fallback remain available.";
const READ_REASON = "Prefer the built-in read tool for source contents (always allowed).";
const WRITE_REASON = "Prefer the built-in edit or write tool for source mutations (always allowed).";
export function isLikelyExactLookup(pattern: string, literal: boolean): boolean {
	if (literal) return true;
	const value = pattern.trim();
	if (!value || value.length <= 2) return true;
	if (/\s/.test(value)) return false;
	return /[A-Z_.:$\\/\-]/.test(value) || /^(?:TODO|FIXME|HACK|XXX)$/i.test(value) || /^[a-z]+\d+$/.test(value);
}
export function classifyGrep(cwd: string, input: Record<string, unknown>): Classification | undefined {
	const path = input.path ?? ".";
	if (typeof path !== "string" || hasParentTraversal(path) || !isScopedPath(cwd, path)) return;
	if (typeof input.pattern === "string" && !isLikelyExactLookup(input.pattern, input.literal === true)) return { kind: "search", reason: SEARCH_REASON };
}
/** Deliberately not a shell interpreter: ambiguous/compound targets fail open. */
function shellWords(command: string): string[] | undefined {
	if (/[\n\r$`*?{}()\[\]]/.test(command)) return;
	const words: string[] = [];
	let word = "", quote = "", started = false;
	for (const char of command.trim()) {
		if (quote) {
			if (char === quote) quote = ""; else word += char;
			started = true;
		} else if (char === "'" || char === '"') { quote = char; started = true; }
		else if (char === "\\") return;
		else if (/\s/.test(char)) { if (started) { words.push(word); word = ""; started = false; } }
		else if (/[|;&<>]/.test(char)) return;
		else { word += char; started = true; }
	}
	if (quote) return;
	if (started) words.push(word);
	return words;
}
function stripHarmlessRedirects(command: string): string {
	return command.replace(/(?:&|\d*)>>?\s*\/dev\/(?:null|stdout|stderr)\b/g, " ").replace(/\d*>&\d+/g, " ");
}
function targetsScoped(cwd: string, paths: string[]): boolean {
	return paths.length > 0 && paths.every((path) => path !== "-" && !hasParentTraversal(path) && isScopedPath(cwd, path));
}
export function classifyBash(cwd: string, command: string): Classification | undefined {
	// A cwd-changing command, even one which changes back, is outside this router's proof.
	if (/\b(?:cd|pushd|popd)\b/.test(command)) return;
	const cleaned = stripHarmlessRedirects(command);
	const redirect = cleaned.match(/^(.*?)\s+>>?\s*(.*?)\s*$/);
	if (redirect) {
		const producer = shellWords(redirect[1]);
		const targets = shellWords(redirect[2]);
		if (producer && ["echo", "printf", "cat"].includes(producer[0]) && targets?.length === 1 && targetsScoped(cwd, targets)) {
			if (producer[0] === "cat" && !targetsScoped(cwd, producer.slice(1))) return;
			return { kind: "write", reason: WRITE_REASON };
		}
		return;
	}
	const words = shellWords(cleaned);
	if (!words?.length) return;
	const [program, ...args] = words;
	if (program === "rg" || program === "grep") {
		let literal = false, pattern: string | undefined;
		const paths: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "-F" || arg === "--fixed-strings") { literal = true; continue; }
			if (arg === "--") { if (pattern === undefined) pattern = args[++i]; paths.push(...args.slice(i + 1)); break; }
			if (["-n", "--line-number", "-i", "--ignore-case", "-l", "--files-with-matches", "-r", "-R", "--hidden"].includes(arg)) continue;
			if (arg.startsWith("-")) return; // option arity/target scope not proven
			if (pattern === undefined) pattern = arg; else paths.push(arg);
		}
		if (pattern !== undefined && targetsScoped(cwd, paths.length ? paths : ["."]) && !isLikelyExactLookup(pattern, literal)) return { kind: "search", reason: SEARCH_REASON };
		return;
	}
	if (["cat", "less", "more", "head", "tail"].includes(program)) {
		const paths: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if ((program === "head" || program === "tail") && ["-n", "-c"].includes(args[i]) && /^\d+$/.test(args[i + 1] ?? "")) { i++; continue; }
			if (args[i].startsWith("-")) return;
			paths.push(args[i]);
		}
		if (targetsScoped(cwd, paths)) return { kind: "read", reason: READ_REASON };
	}
	if (program === "tee") {
		const paths = args[0] === "-a" ? args.slice(1) : args;
		if (paths.some((arg) => arg.startsWith("-"))) return;
		if (targetsScoped(cwd, paths)) return { kind: "write", reason: WRITE_REASON };
	}
	if (program === "sed" || program === "perl") {
		const inplace = args[0] === "-i";
		const rest = inplace ? args.slice(1) : args;
		if (program === "perl" && rest[0] === "-pe") rest.shift();
		if (rest.length < 2 || rest.some((arg) => arg.startsWith("-"))) return;
		if (targetsScoped(cwd, rest.slice(1))) return { kind: inplace ? "write" : "read", reason: inplace ? WRITE_REASON : READ_REASON };
	}
}
