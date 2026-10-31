import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SPILL_MARKER } from "../extensions/lib/events.ts";
import { guardContent } from "../extensions/lib/overflow.ts";

const limits = { maxChars: 1000, headChars: 300, tailChars: 100 };

test("R-O1 small results pass through", () => {
  assert.equal(
    guardContent([{ type: "text", text: "ok" }], tmpdir(), limits, () => {}),
    undefined,
  );
});

test("R-O1 large results are replaced with head, marker, tail and a saved file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-inf-ov-"));
  const text = "H".repeat(400) + "M".repeat(3000) + "T".repeat(400);
  const out = guardContent([{ type: "text", text }], dir, limits, () => {});
  assert.ok(out);
  const first = out[0] as { text: string };
  assert.ok(first.text.includes(SPILL_MARKER));
  assert.ok(first.text.length < 700);
  const path = /saved to (\S+);/.exec(first.text)?.[1] as string;
  assert.equal(readFileSync(path, "utf8"), text);
});

test("R-O2 non-text parts are kept and several text parts are summed", () => {
  const img = { type: "image", data: "xx", mimeType: "image/png" };
  const out = guardContent(
    [{ type: "text", text: "a".repeat(600) }, img, { type: "text", text: "b".repeat(600) }],
    mkdtempSync(join(tmpdir(), "pi-inf-ov-")),
    limits,
    () => {},
  );
  assert.ok(out);
  assert.equal(out.length, 2);
  assert.equal(out[1], img);
});

test("R-O3 already truncated content is left alone", () => {
  const text = `head\n${SPILL_MARKER}: 9999 chars total]\n` + "x".repeat(2000);
  assert.equal(
    guardContent([{ type: "text", text }], tmpdir(), limits, () => {}),
    undefined,
  );
});
