import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Emitter, SPILL_MARKER, formatEventContent, spillIfLarge, type OutgoingMessage } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";

function setup(maxChars = 400, seenCap = 3) {
  const dir = mkdtempSync(join(tmpdir(), "pi-inf-ev-"));
  const sent: OutgoingMessage[] = [];
  const logger = memoryLogger();
  const emitter = new Emitter({ send: (m) => void sent.push(m), spillDir: dir, maxChars, seenCap, logger });
  return { dir, sent, logger, emitter };
}

const base = { sourceId: "j1", kind: "job_exit" as const, seq: 0, source: { tool: "bg_run", callId: "c1", args: { command: "ls" } } };

test("R-E1 emits once per event id", () => {
  const { emitter, sent } = setup();
  assert.equal(emitter.emit({ ...base, body: "done" }), true);
  assert.equal(emitter.emit({ ...base, body: "done again" }), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].details.eventId, "j1:job_exit:0");
  assert.equal(sent[0].details.synthetic, true);
});

test("R-E1 seen set is bounded", () => {
  const { emitter, sent } = setup(400, 2);
  for (let i = 0; i < 3; i++) emitter.emit({ ...base, seq: i, body: "x" });
  assert.equal(sent.length, 3);
  // seq 0 fell out of the set, so it is accepted again
  assert.equal(emitter.emit({ ...base, seq: 0, body: "x" }), true);
});

test("R-E2 large bodies are spilled with head, tail and path", () => {
  const { emitter, sent, dir } = setup(400);
  const body = "A".repeat(300) + "M".repeat(2000) + "Z".repeat(300);
  emitter.emit({ ...base, body });
  const msg = sent[0];
  assert.ok(msg.content.includes(SPILL_MARKER));
  assert.ok(msg.content.length < 1200);
  assert.ok(msg.details.spilledTo?.startsWith(dir));
  assert.equal(readFileSync(msg.details.spilledTo as string, "utf8"), body);
  assert.ok(msg.content.endsWith("Z".repeat(100)));
});

test("R-E2 zero tail spills without including the full body", () => {
  const body = "H".repeat(40) + "M".repeat(1000) + "TAIL";
  const result = spillIfLarge(body, mkdtempSync(join(tmpdir(), "pi-inf-sp-")), { maxChars: 100, headChars: 40, tailChars: 0 }, () => {});
  assert.ok(result.path);
  assert.equal(readFileSync(result.path, "utf8"), body);
  assert.ok(result.text.startsWith("H".repeat(40)));
  assert.ok(result.text.includes(SPILL_MARKER));
  assert.ok(!result.text.includes("TAIL"));
  assert.ok(result.text.length < body.length);
});

test("R-E2 an embedded spill marker cannot bypass the size limit", () => {
  const body = SPILL_MARKER + "x".repeat(500);
  const result = spillIfLarge(body, mkdtempSync(join(tmpdir(), "pi-inf-sp-")), { maxChars: 100, headChars: 40, tailChars: 20 }, () => {});
  assert.ok(result.path);
  assert.equal(readFileSync(result.path, "utf8"), body);
});

test("R-E2 spill write failure still truncates and reports", () => {
  const errors: unknown[] = [];
  const r = spillIfLarge("q".repeat(500), "/dev/null/cannot-create", { maxChars: 100, headChars: 40, tailChars: 20 }, (e) =>
    errors.push(e),
  );
  assert.equal(errors.length, 1);
  assert.equal(r.path, undefined);
  assert.ok(r.text.includes("could not be saved"));
});

test("R-E3 delivery is steer with triggerTurn", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-inf-ev-"));
  const calls: unknown[] = [];
  const e = new Emitter({ send: (_m, o) => void calls.push(o), spillDir: dir, maxChars: 100, seenCap: 5, logger: memoryLogger() });
  e.emit({ ...base, body: "hi" });
  assert.deepEqual(calls, [{ triggerTurn: true, deliverAs: "steer" }]);
});

test("R-E5 emitter never throws when send fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-inf-ev-"));
  const logger = memoryLogger();
  const notes: string[] = [];
  const e = new Emitter({
    send: () => {
      throw new Error("boom");
    },
    spillDir: dir,
    maxChars: 100,
    seenCap: 5,
    logger,
    notify: (m) => notes.push(m),
  });
  assert.equal(e.emit({ ...base, body: "hi" }), false);
  assert.equal(logger.lines.length, 1);
  assert.equal(notes.length, 1);
});

test("R-E5 notification failure is logged without throwing", () => {
  const logger = memoryLogger();
  const emitter = new Emitter({
    send: () => {
      throw new Error("send failed");
    },
    spillDir: tmpdir(),
    maxChars: 100,
    seenCap: 5,
    logger,
    notify: () => {
      throw new Error("notify failed");
    },
  });
  assert.equal(emitter.emit({ ...base, body: "hi" }), false);
  assert.equal(logger.lines.length, 2);
  assert.match(logger.lines[1], /events\.notify.*notify failed/);
});

test("R-E6 persists before send and replays only unacknowledged branch events", () => {
  const input = { ...base, body: "done" };
  const persisted: unknown[] = [];
  const sent: OutgoingMessage[] = [];
  const options = { spillDir: tmpdir(), maxChars: 400, seenCap: 3, logger: memoryLogger() };
  const first = new Emitter({
    ...options,
    persist: (e) => persisted.push(e),
    send: (m) => {
      assert.equal(persisted.length, 1);
      sent.push(m);
    },
  });
  first.emit(input);
  const pending = { type: "custom", customType: "infinity-event-pending", data: input };
  const replayed: OutgoingMessage[] = [];
  const resumed = new Emitter({ ...options, persist: () => assert.fail("must not repersist"), send: (m) => replayed.push(m) });
  resumed.restore([pending]);
  assert.equal(replayed.length, 1);
  const acknowledged = new Emitter({ ...options, send: (m) => replayed.push(m) });
  acknowledged.restore([pending, { type: "custom_message", customType: "infinity-event", details: sent[0].details }]);
  assert.equal(replayed.length, 1);
  assert.equal(acknowledged.emit(input), false);
});

test("R-E6 send or persistence failure is retryable", () => {
  let failPersist = true;
  let failSend = true;
  let writes = 0;
  const emitter = new Emitter({
    spillDir: tmpdir(),
    maxChars: 400,
    seenCap: 3,
    logger: memoryLogger(),
    persist: () => {
      if (failPersist) throw new Error("persist");
      writes++;
    },
    send: () => {
      if (failSend) throw new Error("send");
    },
  });
  const input = { ...base, body: "done" };
  assert.equal(emitter.emit(input), false);
  failPersist = false;
  assert.equal(emitter.emit(input), false);
  failSend = false;
  assert.equal(emitter.emit(input), true);
  assert.equal(writes, 1);
});

test("content format is stable", () => {
  const text = formatEventContent({ ...base, body: "b" }, "b");
  assert.equal(text, '[infinity event] job_exit from bg_run (c1)\noriginal_args: {"command":"ls"}\n---\nb');
});
