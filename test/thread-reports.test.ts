import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeReport, renderReport } from "../extensions/lib/threads/reports.ts";

test("R-H6a structured reports round-trip and render concisely", () => {
  const text = encodeReport(undefined, { summary: "Done", files: ["a.ts"], tests: ["passed"], blockers: [] }, true)!;
  assert.equal(renderReport(text), "Done\nFiles: a.ts\nTests: passed");
  assert.equal(encodeReport("legacy", undefined, true), "legacy");
  assert.equal(encodeReport(undefined, undefined, false), undefined);
});

test("R-H6a validates reports and preserves unrecognized text", () => {
  assert.throws(() => encodeReport(undefined, undefined, true), /Provide report/);
  assert.throws(() => encodeReport("text", { summary: "x" }, true), /either/);
  for (const value of [{ summary: " " }, { summary: "x", files: [1] }, { summary: "x", extra: true }, null]) {
    assert.throws(() => encodeReport(undefined, value, true), /Invalid structured/);
    assert.equal(renderReport(JSON.stringify(value)), JSON.stringify(value));
  }
  assert.equal(renderReport("plain report"), "plain report");
});

test("R-RLM2 evidence and coverage round-trip as unverified claims", () => {
  const report = {
    summary: "Reviewed",
    evidence: [{ source: "file.ts", start: 1, end: 1, claim: "A claim" }],
    coverage: [
      { source: "file.ts", start: 1, end: 10, status: "read" },
      { source: "file.ts", start: 11, end: 12, status: "partial" },
      { source: "other", start: 2, end: 3, status: "failed" },
    ],
  };
  const encoded = encodeReport(undefined, report, true)!;
  assert.deepEqual(JSON.parse(encoded), report);
  assert.equal(
    renderReport(encoded),
    "Reviewed\nEvidence (unverified): file.ts:1-1: A claim\nCoverage (unverified): file.ts:1-10: read\nCoverage (unverified): file.ts:11-12: partial\nCoverage (unverified): other:2-3: failed",
  );
  assert.equal(renderReport(encodeReport(undefined, { summary: "Old", evidence: [], coverage: [] }, true)!), "Old");
});

test("R-RLM2 rejects invalid entries and preserves unrecognized reports", () => {
  const entry = { source: "file", start: 1, end: 2, claim: "claim" };
  const invalid = [
    { ...entry, source: " " },
    { ...entry, claim: " " },
    { ...entry, start: 0 },
    { ...entry, start: 1.5 },
    { ...entry, end: Number.MAX_SAFE_INTEGER + 1 },
    { ...entry, start: 3 },
    { ...entry, extra: true },
    null,
  ];
  for (const item of invalid) {
    const value = { summary: "x", evidence: [item] };
    assert.throws(() => encodeReport(undefined, value, true), /Invalid structured/);
    assert.equal(renderReport(JSON.stringify(value)), JSON.stringify(value));
  }
  for (const coverage of [
    null,
    {},
    [{ source: "x", start: 1, end: 2, status: "unknown" }],
    [{ source: "x", start: -1, end: 2, status: "read" }],
  ]) {
    const value = { summary: "x", coverage };
    assert.throws(() => encodeReport(undefined, value, true), /Invalid structured/);
    assert.equal(renderReport(JSON.stringify(value)), JSON.stringify(value));
  }
});

test("R-RLM2 rejects sparse arrays and representation-changing serialization", () => {
  for (const key of ["files", "tests", "blockers", "evidence", "coverage"]) {
    assert.throws(() => encodeReport(undefined, { summary: "x", [key]: new Array(1) }, true), /Invalid structured/);
  }
  const entry = { source: "file", start: 1, end: 2, claim: "claim" };
  const changedEntry = Object.defineProperty(entry, "toJSON", { value: () => ({ ...entry, claim: "changed" }) });
  const changedReport = Object.defineProperty({ summary: "x" }, "toJSON", { value: () => ({ summary: "different" }) });
  const changedArray = Object.defineProperty(["a"], "toJSON", { value: () => [] });
  for (const report of [changedReport, { summary: "x", files: changedArray }, { summary: "x", evidence: [changedEntry] }]) {
    assert.throws(() => encodeReport(undefined, report, true), /Invalid structured/);
  }
  assert.deepEqual(JSON.parse(encodeReport(undefined, { summary: "x", files: undefined, evidence: [] }, true)!), {
    summary: "x",
    evidence: [],
  });
});

test("R-H6a structured reports preserve Unicode and escaped text; malformed or mismatched JSON stays literal", () => {
  const summary = 'Done: β, ✓, "quoted"\nnext line';
  const encoded = encodeReport(undefined, { summary, files: ["目录/a.ts", "space name.ts"], blockers: ["one, two"] }, true)!;
  assert.equal(renderReport(encoded), `${summary}\nFiles: 目录/a.ts, space name.ts\nBlockers: one, two`);
  for (const text of ['{"summary":', '{"summary":"ok","tests":null}', '[{"summary":"ok"}]', '"plain"', "42"]) {
    assert.equal(renderReport(text), text);
  }
  assert.throws(() => encodeReport("", { summary: "x" }, false), /either/);
  assert.equal(encodeReport("", undefined, true), "");
});
