import { test } from "node:test";
import assert from "node:assert/strict";
import { assessCoverage, MAX_COVERAGE_ENTRIES } from "../extensions/lib/coverage.ts";
import { coverageTools } from "../extensions/tools/coverage.ts";

const range = (start: number, end: number, source = "a") => ({ source, start, end });

test("R-RLM3 duplicate and overlapping reads do not conceal gaps, preserving assigned order", () => {
  const result = assessCoverage({
    assigned: [range(1, 20), range(3, 7), range(1, 2, "b")],
    coverage: [
      { ...range(10, 12), status: "read" },
      { ...range(1, 4), status: "read" },
      { ...range(1, 4), status: "read" },
      { ...range(3, 6), status: "read" },
      { ...range(11, 15), status: "read" },
    ],
  });
  assert.deepEqual(result.missing, [range(7, 9), range(16, 20), range(7, 7), range(1, 2, "b")]);
});

test("R-RLM3 retains partial, failed, evidence and unknown sources in input order", () => {
  const coverage = [
    { ...range(1, 5), status: "partial" },
    { ...range(2, 4, "unknown"), status: "failed" },
    { ...range(1, 3), status: "read" },
  ];
  const evidence = [
    { ...range(1, 2, "other"), claim: "claim" },
    { ...range(1, 1, "unknown"), claim: "another" },
  ];
  assert.deepEqual(assessCoverage({ assigned: [range(1, 5)], coverage, evidence }), {
    missing: [range(4, 5)],
    failures: coverage.slice(0, 2),
    evidence,
    unknownSources: ["unknown", "other"],
  });
});

test("R-RLM3 validates untrusted inputs and bounds resource use", () => {
  for (const input of [
    null,
    {},
    { assigned: [range(0, 1)], coverage: [] },
    { assigned: [range(2, 1)], coverage: [] },
    { assigned: [range(1, Number.MAX_SAFE_INTEGER + 1)], coverage: [] },
    { assigned: [range(1, 2, " ")], coverage: [] },
    { assigned: [], coverage: [{ ...range(1, 1), status: "maybe" }] },
    { assigned: [], coverage: [], evidence: [{ ...range(1, 1), claim: " " }] },
    { assigned: [], coverage: [], extra: true },
    { assigned: Array.from({ length: MAX_COVERAGE_ENTRIES + 1 }, () => range(1, 1)), coverage: [] },
  ])
    assert.throws(() => assessCoverage(input));
  assert.deepEqual(
    assessCoverage({
      assigned: [range(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)],
      coverage: [{ ...range(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), status: "read" }],
    }).missing,
    [],
  );
});

test("R-RLM3 tool returns unverified assessment and validates at execution boundary", async () => {
  const tool = coverageTools()[0];
  const result = await tool.execute("id", { assigned: [range(1, 2)], coverage: [] }, undefined, () => {}, {} as never);
  assert.deepEqual(result.details.missing, [range(1, 2)]);
  assert.match(tool.description, /does not read sources/);
  await assert.rejects(() => tool.execute("id", { assigned: [range(0, 1)], coverage: [] }, undefined, () => {}, {} as never));
});
