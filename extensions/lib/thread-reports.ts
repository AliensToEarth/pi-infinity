export interface StructuredReport {
  summary: string;
  files?: string[];
  tests?: string[];
  blockers?: string[];
}

/** Only the documented shape is treated as structured; other text is left untouched. */
export function isStructuredReport(value: unknown): value is StructuredReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !["summary", "files", "tests", "blockers"].includes(key))) return false;
  if (typeof obj.summary !== "string" || !obj.summary.trim()) return false;
  return ["files", "tests", "blockers"].every(
    (key) => obj[key] === undefined || (Array.isArray(obj[key]) && obj[key].every((item: unknown) => typeof item === "string")),
  );
}

export function encodeReport(report: string | undefined, structured: unknown, required: boolean): string | undefined {
  if (report !== undefined && structured !== undefined) throw new Error("Provide either report or structured, not both.");
  if (structured !== undefined) {
    if (!isStructuredReport(structured))
      throw new Error("Invalid structured report: expected summary and optional string arrays files, tests, blockers.");
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
  return lines.join("\n");
}
