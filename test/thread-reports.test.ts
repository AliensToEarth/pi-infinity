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
