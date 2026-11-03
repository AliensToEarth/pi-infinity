import type { Coverage, Evidence } from "./thread-reports.ts";

export interface Range {
  source: string;
  start: number;
  end: number;
}

export interface CoverageAssessment {
  missing: Range[];
  failures: Coverage[];
  evidence: Evidence[];
  unknownSources: string[];
}

export const MAX_COVERAGE_ENTRIES = 1000;
export const MAX_SOURCE_LENGTH = 1024;
export const MAX_CLAIM_LENGTH = 4096;
const MAX_MISSING = 10000;

function entry(value: unknown, kind: "assigned" | "coverage" | "evidence"): Range | Coverage | Evidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${kind} entry`);
  const item = value as Record<string, unknown>;
  const keys = kind === "assigned" ? ["source", "start", "end"] : ["source", "start", "end", kind === "coverage" ? "status" : "claim"];
  if (Object.keys(item).some((key) => !keys.includes(key))) throw new Error(`Invalid ${kind} entry`);
  if (typeof item.source !== "string" || !item.source.trim() || item.source.length > MAX_SOURCE_LENGTH)
    throw new Error(`Invalid ${kind} source`);
  if (
    !Number.isSafeInteger(item.start) ||
    (item.start as number) < 1 ||
    !Number.isSafeInteger(item.end) ||
    (item.end as number) < (item.start as number)
  )
    throw new Error(`Invalid ${kind} range`);
  const range = { source: item.source, start: item.start as number, end: item.end as number };
  if (kind === "coverage") {
    if (item.status !== "read" && item.status !== "partial" && item.status !== "failed") throw new Error("Invalid coverage status");
    return { ...range, status: item.status };
  }
  if (kind === "evidence") {
    if (typeof item.claim !== "string" || !item.claim.trim() || item.claim.length > MAX_CLAIM_LENGTH)
      throw new Error("Invalid evidence claim");
    return { ...range, claim: item.claim };
  }
  return range;
}

/** Compare supplied claims only; this does not access sources or verify reports. */
export function assessCoverage(input: unknown): CoverageAssessment {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid coverage assessment input");
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !["assigned", "coverage", "evidence"].includes(key)))
    throw new Error("Invalid coverage assessment input");
  if (!Array.isArray(obj.assigned) || !Array.isArray(obj.coverage) || (obj.evidence !== undefined && !Array.isArray(obj.evidence)))
    throw new Error("Expected assigned and coverage arrays and optional evidence array");
  const evidenceInput = (obj.evidence ?? []) as unknown[];
  if (obj.assigned.length + obj.coverage.length + evidenceInput.length > MAX_COVERAGE_ENTRIES)
    throw new Error(`At most ${MAX_COVERAGE_ENTRIES} total entries are allowed`);
  const assigned = obj.assigned.map((item) => entry(item, "assigned") as Range);
  const coverage = obj.coverage.map((item) => entry(item, "coverage") as Coverage);
  const evidence = evidenceInput.map((item) => entry(item, "evidence") as Evidence);
  const known = new Set(assigned.map((item) => item.source));
  const unknownSources = [...new Set([...coverage, ...evidence].map((item) => item.source).filter((source) => !known.has(source)))];
  const reads = new Map<string, Range[]>();
  for (const item of coverage) {
    if (item.status !== "read") continue;
    const list = reads.get(item.source) ?? [];
    list.push(item);
    reads.set(item.source, list);
  }
  for (const list of reads.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
  const missing: Range[] = [];
  function add(source: string, start: number, end: number): void {
    if (missing.length === MAX_MISSING) throw new Error(`More than ${MAX_MISSING} missing ranges`);
    missing.push({ source, start, end });
  }
  for (const range of assigned) {
    let cursor = range.start;
    let complete = false;
    for (const read of reads.get(range.source) ?? []) {
      if (read.end < cursor) continue;
      if (read.start > range.end) break;
      if (read.start > cursor) add(range.source, cursor, read.start - 1);
      if (read.end >= range.end) {
        complete = true;
        break;
      }
      cursor = Math.max(cursor, read.end + 1);
    }
    if (!complete) add(range.source, cursor, range.end);
  }
  return { missing, failures: coverage.filter((item) => item.status !== "read"), evidence, unknownSources };
}
