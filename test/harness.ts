import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodebaseRouter, type RouterOptions } from "../src/controller.js";

export const fixtureBin = resolve("test/fixtures/mcp-server.mjs");
export function tempDirectory(): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "cbrouter-test-"));
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export function jsonFile(path: string, value: unknown): void {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
// The harness intentionally permits partial host event payloads, including old/custom messages.
type Handler = (event: any, ctx: ExtensionContext) => any;
export function harness(root: string, overrides: Partial<RouterOptions> = {}) {
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	jsonFile(join(cwd, "package.json"), { name: "fixture" });
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const entries: any[] = [];
	const statuses: (string | undefined)[] = [];
	const notifications: { text: string; type?: string }[] = [];
	const messages: unknown[] = [];
	let toolNames = ["read", "edit", "write", "grep", "bash", "index_status", "index_codebase", "codebase_context", "codebase_edit_context", "architecture_context", "codebase_peek", "implementation_lookup", "codebase_search", "call_graph", "call_graph_path"];
	let trusted = true, sessionId = "test-session", appendError = false;
	let activeTools: string[] | undefined;
	let exposures: Record<string, string> = {};
	const pi = {
		on(name: string, handler: Handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerCommand(name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, options); },
		getAllTools: () => toolNames.map((name) => ({ name, exposure: exposures[name] })),
		getActiveTools: () => activeTools ?? toolNames,
		appendEntry(customType: string, data: unknown) {
			if (appendError) throw new Error("append failed");
			entries.push({ type: "custom", customType, data });
		},
		sendUserMessage(content: unknown, options: unknown) { messages.push({ content, options }); },
		sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd, hasUI: true, mode: "tui", isProjectTrusted: () => trusted,
		sessionManager: { getBranch: () => entries, getSessionId: () => sessionId },
		ui: {
			setStatus(_key: string, value?: string) { statuses.push(value); },
			notify(text: string, type?: string) { notifications.push({ text, type }); },
		},
	} as unknown as ExtensionCommandContext;
	const options: RouterOptions = { agentDir: join(root, "agent"), projectConfigDir: ".pi", env: { XDG_CONFIG_HOME: join(root, "config") }, ...overrides };
	const controller = registerCodebaseRouter(pi, options);
	return {
		controller, pi, ctx, options, entries, statuses, notifications, messages,
		setTools(names: string[]) { toolNames = names; },
		setActiveTools(names: string[]) { activeTools = names; },
		setExposures(values: Record<string, string>) { exposures = values; },
		setTrusted(value: boolean) { trusted = value; },
		setSessionId(value: string) { sessionId = value; },
		setAppendError(value: boolean) { appendError = value; },
		async emit(name: string, event: unknown = {}) {
			let result: any;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
			return result;
		},
		async command(args: string, name = "cbrouter") { await commands.get(name)!.handler(args, ctx); },
		commands,
		commandDefinition: commands.get("cbrouter")!,
	};
}
export function userStartEvent(prompt = "fix source") {
	return {
		type: "before_agent_start" as const, messageType: "user" as const, prompt, systemPrompt: "base",
		systemPromptOptions: { sections: {} as Record<string, string>, promptGuidelines: [] as string[] },
	};
}
export const textResult = (text: string, details?: unknown) => ({ content: [{ type: "text", text }], details });
export async function waitFor(predicate: () => boolean, message = "condition", timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
export function fixtureLog(cwd: string): any[] {
	try { return readFileSync(join(cwd, ".mcp-log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
	catch { return []; }
}
