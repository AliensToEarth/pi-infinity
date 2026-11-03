export interface Evidence {
  source: string;
  start: number;
  end: number;
  claim: string;
}

export interface Coverage {
  source: string;
  start: number;
  end: number;
  status: "read" | "partial" | "failed";
}

export interface StructuredReport {
  summary: string;
  files?: string[];
  tests?: string[];
  blockers?: string[];
  evidence?: Evidence[];
  coverage?: Coverage[];
}

function validEntry(value: unknown, kind: "evidence" | "coverage"): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const field = kind === "evidence" ? "claim" : "status";
  if (Object.keys(entry).some((key) => !["source", "start", "end", field].includes(key))) return false;
  if (typeof entry.source !== "string" || !entry.source.trim()) return false;
  if (typeof entry.start !== "number" || !Number.isSafeInteger(entry.start) || entry.start < 1) return false;
  if (typeof entry.end !== "number" || !Number.isSafeInteger(entry.end) || entry.end < entry.start) return false;
  return kind === "evidence"
    ? typeof entry.claim === "string" && !!entry.claim.trim()
    : entry.status === "read" || entry.status === "partial" || entry.status === "failed";
}

/** Only the documented shape is treated as structured; other text is left untouched. */
export function isStructuredReport(value: unknown): value is StructuredReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !["summary", "files", "tests", "blockers", "evidence", "coverage"].includes(key))) return false;
  if (typeof obj.summary !== "string" || !obj.summary.trim()) return false;
  return (
    ["files", "tests", "blockers"].every(
      (key) => obj[key] === undefined || (Array.isArray(obj[key]) && obj[key].every((item: unknown) => typeof item === "string")),
    ) &&
    (["evidence", "coverage"] as const).every(
      (key) => obj[key] === undefined || (Array.isArray(obj[key]) && obj[key].every((entry: unknown) => validEntry(entry, key))),
    )
  );
}

export function encodeReport(report: string | undefined, structured: unknown, required: boolean): string | undefined {
  if (report !== undefined && structured !== undefined) throw new Error("Provide either report or structured, not both.");
  if (structured !== undefined) {
    if (!isStructuredReport(structured))
      throw new Error("Invalid structured report: expected summary and valid optional files, tests, blockers, evidence and coverage.");
    return JSON.stringify(structured);
  }
  if (required && report === undefined) throw new Error("Provide report or structured.");
  return report;
}

export function renderReport(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isStructuredReport(value)) return text;
  const lines = [value.summary];
  for (const [label, items] of [
    ["Files", value.files],
    ["Tests", value.tests],
    ["Blockers", value.blockers],
  ] as const) {
    if (items?.length) lines.push(`${label}: ${items.join(", ")}`);
  }
  for (const item of value.evidence ?? []) lines.push(`Evidence (unverified): ${item.source}:${item.start}-${item.end}: ${item.claim}`);
  for (const item of value.coverage ?? []) lines.push(`Coverage (unverified): ${item.source}:${item.start}-${item.end}: ${item.status}`);
  return lines.join("\n");
}
