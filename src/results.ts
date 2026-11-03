import { asRecord } from "./config.js";

export function resultText(result: unknown): string {
	const record = asRecord(result);
	return Array.isArray(record.content) ? record.content.map((item) => {
		const block = asRecord(item);
		return block.type === "text" && typeof block.text === "string" ? block.text : "";
	}).join("\n") : "";
}
function resultDetails(result: unknown): Record<string, unknown> {
	const record = asRecord(result);
	return { ...asRecord(record.structuredContent), ...asRecord(record.details) };
}
/** Structural errors only: successful retrieval and edit results contain arbitrary source text. */
export function resultFailure(result: unknown, isError = false): string | undefined {
	const record = asRecord(result);
	const details = resultDetails(result);
	if ([details.code, record.code].includes("INDEX_BUSY")) return "index busy";
	if (isError || record.isError === true || record.error || details.error) return "tool reported an error";
	return undefined;
}
/** Only call for index_status/index_codebase, whose text is operational output, not source. */
export function readinessFailure(result: unknown, isError = false): string | undefined {
	const failure = resultFailure(result, isError);
	if (failure) return failure;
	const details = resultDetails(result);
	if (details.indexed === false) return "index missing/unindexed";
	if (Number(details.failedChunks) > 0 || Number(details.failedBatchesCount) > 0) return "index has failed embedding batches";
	if (details.resetCorruptedIndex === true) return "index reset after corruption; incremental rebuild required";
	if (details.migrationRequired === true) return "index storage migration required; run incremental /cbindex";
	if (asRecord(details.compatibility).compatible === false) return "index incompatible";
	if (["missing", "empty", "unindexed", "incompatible", "migration_required"].includes(String(details.status ?? asRecord(details.branchReadiness).state))) return "index not ready";
	const text = resultText(result);
	if (/\bINDEX_BUSY\b/i.test(text)) return "index busy";
	if (/^(?:index_codebase failed:|error:)|\b(?:indexing (?:failed|was stopped)|stopped or superseded)\b/im.test(text)) return "index operation failed; check index_status";
	if (/^COMPATIBILITY WARNING:/im.test(text)) return "index incompatible";
	if (/\b(?:not indexed|unindexed|index (?:is )?(?:missing|incompatible)|no index (?:found|available)|requires? (?:a )?(?:storage )?migration|migration required|storage migrations: pending|INDEXING WARNING|corrupted local index and reset)\b/i.test(text)) return "index not ready; check index_status";
	return undefined;
}
/** Query/validation errors do not establish index health. Never inspect successful source output. */
export function retrievalReadinessFailure(result: unknown, isError = false): string | undefined {
	const record = asRecord(result);
	const details = resultDetails(result);
	const codes = [record.code, details.code, asRecord(record.error).code, asRecord(details.error).code];
	if (codes.includes("INDEX_BUSY")) return "index busy";
	if (codes.some((code) => typeof code === "string" && /^(?:INDEX_(?:MISSING|NOT_READY|NOT_FOUND|UNINDEXED|INCOMPATIBLE)|EMBEDDING_(?:MODEL|STRATEGY|DIMENSION)_MISMATCH|MIGRATION_REQUIRED)$/.test(code))) return "index unavailable; check index_status";
	// Native Pi throws provider incompatibility as a tool error without a structured code.
	if ((isError || record.isError === true) && /^(?:(?:Model|Dimension|Path storage format|Embedding strategy) mismatch:|Index (?:is )?(?:incompatible|not initialized)|Codebase is not indexed\b|The existing index (?:is|requires|has)\b|Automatic indexing (?:failed|stopped|is)\b)/i.test(resultText(result).trim())) return "index unavailable; check index_status";
	return undefined;
}
export function statusIsReady(result: unknown): boolean {
	if (readinessFailure(result)) return false;
	const details = resultDetails(result);
	if (details.indexed === true) return true;
	const text = resultText(result);
	// MCP omits native Pi details; require explicit positive operational status fields.
	const positiveCount = /^(?:Indexed chunks(?: \(all branches\))?|Stored chunks \(structural, all branches\)): [1-9]\d*\b/m.test(text);
	const catalog = /^Active branch catalog state: (\S+)/m.exec(text);
	if (catalog && !["ready", "legacy"].includes(catalog[1])) return false;
	return positiveCount && (Boolean(catalog) || /^Compatibility: (?:Index is compatible|Structural index)\b/m.test(text));
}
