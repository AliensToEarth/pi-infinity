import assert from "node:assert/strict";
import test from "node:test";
import { isThreadId, newThreadId } from "../extensions/lib/threads/protocol.ts";

test("R-H0 new thread ids are unique 128-bit identifiers and legacy ids remain valid", () => {
  const ids = new Set(Array.from({ length: 10000 }, () => newThreadId()));
  assert.equal(ids.size, 10000);
  for (const id of ids) {
    assert.match(id, /^t-[0-9a-f]{32}$/);
    assert.ok(isThreadId(id));
  }
  assert.ok(isThreadId("t-abcdef"));
  assert.equal(isThreadId("t-abcdef0"), false);
});
