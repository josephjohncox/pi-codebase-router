import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve symlinks through the nearest existing parent, including for new files. */
export function canonicalPath(path: string, seen = new Set<string>()): string | undefined {
	if (seen.has(path)) return undefined;
	seen.add(path);
	try { return realpathSync(path); } catch (error) {
		if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		try {
			if (lstatSync(path).isSymbolicLink()) return canonicalPath(resolve(dirname(path), readlinkSync(path)), seen);
		} catch { /* missing path; resolve its parent */ }
		const parent = dirname(path);
		if (parent === path) return undefined;
		const canonicalParent = canonicalPath(parent, seen);
		return canonicalParent ? join(canonicalParent, relative(parent, path)) : undefined;
	}
}
export function isScopedPath(cwd: string, input: unknown): boolean {
	if (typeof input !== "string" || !input.trim()) return false;
	let path = input.replace(/^@/, "");
	if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
	const root = canonicalPath(resolve(cwd));
	const target = canonicalPath(resolve(cwd, path));
	if (!root || !target) return false;
	const rel = relative(root, target);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
	// A worktree nested below cwd is another checkout, not part of this index.
	for (let directory = target; directory !== root; directory = dirname(directory)) {
		if (linkedWorktreeAt(directory)) return false;
	}
	return true;
}
function linkedWorktreeAt(directory: string): boolean {
	try {
		const marker = join(directory, ".git");
		if (!lstatSync(marker).isFile()) return false;
		const match = /^gitdir:\s*(.+)\s*$/i.exec(readFileSync(marker, "utf8").trim());
		if (!match) return false;
		const gitDir = resolve(directory, match[1]);
		return existsSync(join(gitDir, "commondir")) && existsSync(join(gitDir, "gitdir"));
	} catch { return false; }
}
export function hasParentTraversal(path: string): boolean {
	return path.replace(/^@/, "").split(/[\\/]/).includes("..");
}
export interface ProjectScope { linkedWorktree: boolean; project: boolean; }
/** Git's common-dir comparison distinguishes linked worktrees from submodules. */
export function inspectProject(cwd: string): ProjectScope {
	const project = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"].some((marker) => existsSync(join(cwd, marker)));
	try {
		const output = execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim().split("\n");
		const [gitDir, commonDir] = output.map((path) => canonicalPath(resolve(cwd, path)));
		return { project: true, linkedWorktree: Boolean(gitDir && commonDir && gitDir !== commonDir && existsSync(join(gitDir, "commondir")) && existsSync(join(gitDir, "gitdir"))) };
	} catch {
		// Missing/older Git must not silently turn worktree bypass into enforcement.
		for (let directory = resolve(cwd); ; directory = dirname(directory)) {
			if (existsSync(join(directory, ".git"))) return { project: true, linkedWorktree: linkedWorktreeAt(directory) };
			if (dirname(directory) === directory) break;
		}
		return { project, linkedWorktree: false };
	}
}
