import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeReport, renderReport } from "../extensions/lib/thread-reports.ts";

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
