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

test("R-O1 zero tail keeps the saved output but not the full body in the preview", () => {
  const text = "H".repeat(300) + "M".repeat(2000) + "TAIL";
  const out = guardContent([{ type: "text", text }], mkdtempSync(join(tmpdir(), "pi-inf-ov-")), { ...limits, tailChars: 0 }, () => {});
  assert.ok(out);
  const preview = (out[0] as { text: string }).text;
  const path = /saved to (\S+);/.exec(preview)?.[1];
  assert.ok(path);
  assert.equal(readFileSync(path, "utf8"), text);
  assert.ok(preview.startsWith("H".repeat(300)));
  assert.ok(!preview.includes("TAIL"));
  assert.ok(preview.length < text.length);
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

test("R-O3 an embedded spill marker cannot bypass the guard", () => {
  const text = `head\n${SPILL_MARKER}: 9999 chars total]\n` + "x".repeat(2000);
  const out = guardContent([{ type: "text", text }], mkdtempSync(join(tmpdir(), "pi-inf-ov-")), limits, () => {});
  assert.ok(out);
  const path = /saved to (\S+);/.exec((out[0] as { text: string }).text)?.[1];
  assert.ok(path);
  assert.equal(readFileSync(path, "utf8"), text);
});
