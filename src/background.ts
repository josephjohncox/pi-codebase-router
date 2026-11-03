import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RouterConfig } from "./config.js";
import { asRecord } from "./config.js";
import { readinessFailure } from "./results.js";

const PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export interface IndexLauncher { command: string; args: string[]; }
export interface IndexOutcome { success: boolean; message: string; }
export function resolveIndexLauncher(cwd: string, config: RouterConfig, agentDir: string, projectConfigDir: string, trusted = false): IndexLauncher | undefined {
	// An explicit missing path is an error, not a request to try another binary.
	const candidates = config.indexBin ? [resolve(cwd, config.indexBin)] : [
		join(agentDir, "npm", "node_modules", "opencode-codebase-index", "dist", "cli.js"),
		...(trusted ? [join(cwd, projectConfigDir, "npm", "node_modules", "opencode-codebase-index", "dist", "cli.js")] : []),
	];
	const path = candidates.find((candidate) => existsSync(candidate));
	return path ? { command: process.execPath, args: [path] } : undefined;
}
interface Job { cancel(): void; }
/** Owns only router-spawned MCP children, never the companion's in-process watcher. */
export class BackgroundIndexer {
	private job?: Job;
	get running(): boolean { return this.job !== undefined; }
	cancel(): void {
		const job = this.job;
		this.job = undefined; // Invalidate callbacks before terminating a child.
		job?.cancel();
	}
	start(cwd: string, launcher: IndexLauncher, timeoutMs: number, onComplete: (outcome: IndexOutcome) => void): void {
		if (this.job) return;
		let child: ChildProcess;
		try {
			child = spawn(launcher.command, [...launcher.args, "--project", cwd, "--host", "pi"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
		} catch (error) { onComplete({ success: false, message: `index launch failed: ${error}` }); return; }
		let settled = false, initialized = false, completed = false;
		let buffer = "";
		let outcome: IndexOutcome | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const closePipes = () => { child.stdin?.destroy(); child.stdout?.destroy(); };
		const terminate = () => {
			try { child.kill("SIGTERM"); } catch { /* exited */ }
			killTimer = setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* exited */ }
			}, 1000);
			killTimer.unref();
		};
		const finish = () => {
			if (completed) return;
			completed = true;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			closePipes();
			if (this.job !== job) return;
			this.job = undefined;
			onComplete(outcome ?? { success: false, message: "index process exited before a result" });
		};
		const settle = (result: IndexOutcome) => {
			if (settled) return;
			settled = true;
			outcome = result;
			clearTimeout(timer);
			closePipes();
			terminate();
		};
		const job: Job = { cancel: () => {
			settled = true;
			clearTimeout(timer);
			closePipes();
			if (!killTimer) terminate();
		} };
		this.job = job;
		const timer = setTimeout(() => settle({ success: false, message: "index timed out" }), timeoutMs);
		timer.unref();
		const send = (message: unknown) => {
			if (settled) return;
			try { child.stdin?.write(`${JSON.stringify(message)}\n`); }
			catch (error) { settle({ success: false, message: `index transport error: ${error}` }); }
		};
		child.stdin?.on("error", () => settle({ success: false, message: "index transport error" }));
		child.stdout?.on("error", () => settle({ success: false, message: "index transport error" }));
		child.stdout?.on("data", (chunk: Buffer) => {
			if (settled) return;
			buffer += chunk.toString();
			if (buffer.length > 4 * 1024 * 1024) { settle({ success: false, message: "index response exceeded buffer limit" }); return; }
			let newline: number;
			while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let message: Record<string, unknown>;
				try { message = asRecord(JSON.parse(line)); } catch { continue; } // non-protocol diagnostics
				if (message.id === 1 && !initialized) {
					if (message.error || !asRecord(message.result).protocolVersion) { settle({ success: false, message: "index MCP initialization failed" }); continue; }
					initialized = true;
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "index_codebase", arguments: { force: false } } });
				} else if (message.id === 2 && initialized) {
					const result = asRecord(message.result);
					const failure = message.error ? "index MCP call failed" : readinessFailure(result);
					if (!Array.isArray(result.content) || result.content.length === 0) settle({ success: false, message: failure ?? "index returned no result" });
					else settle({ success: !failure, message: failure ?? "index refreshed (background)" });
				}
			}
		});
		child.on("error", () => {
			settle({ success: false, message: "index process error" });
			finish(); // spawn errors need not emit exit
		});
		child.once("exit", finish);
		child.once("close", finish);
		send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
			protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-codebase-router", version: PACKAGE_VERSION },
		} });
	}
}
