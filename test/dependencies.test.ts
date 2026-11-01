import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { Emitter } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { ThreadService, type ThreadIO } from "../extensions/lib/thread-service.ts";
import { ThreadFiles, identify } from "../extensions/lib/threads.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "inf-deps-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const events: string[] = [];
  const emitter = new Emitter({
    send: (m) => {
      events.push(m.content);
    },
    spillDir: dir,
    maxChars: 4000,
    seenCap: 100,
    logger,
  });
  const svc = new ThreadService({ identity: identify({}, files), files, sandboxes: [], emitter, config: DEFAULT_CONFIG, logger });
  const pending: Array<(result: { output: string; isError: boolean }) => void> = [];
  const io: ThreadIO = {
    cwd: dir,
    transport: "subagents",
    launch: async () => ({}),
    sendToChild: async () => {},
    launchDetached: () => ({ done: new Promise((resolve) => pending.push(resolve)), abort: () => {} }),
  };
  const params = { instructions: "work", child_of: ["root"], fresh_context: true };
  return { svc, io, pending, params, events };
}

test("R-H6b dependencies validate before launch and unblock only after all completion events", async () => {
  const h = setup();
  const a = await h.svc.spawn(h.params, h.io);
  const b = await h.svc.spawn(h.params, h.io);
  const spawn = (depends_on: string[]) => h.svc.spawn({ ...h.params, depends_on, sandbox: true }, h.io);
  await assert.rejects(spawn(["t-ffffff"]), /not a known direct child/);
  await assert.rejects(spawn([a.id, a.id]), /duplicate/);
  await assert.rejects(spawn([a.id, b.id]), /still running/);
  h.pending[0]({ output: "done", isError: false });
  await Promise.resolve();
  assert.equal(h.events.length, 1);
  await assert.rejects(spawn([a.id, b.id]), /still running/);
  h.pending[1]({ output: "done", isError: false });
  await Promise.resolve();
  assert.equal(h.events.length, 2);
  await h.svc.spawn({ ...h.params, depends_on: [a.id, b.id] }, h.io);
  assert.equal(h.pending.length, 3);
  h.svc.dispose();
});

test("R-H6b known detached failure rejects dependent work", async () => {
  const h = setup();
  const a = await h.svc.spawn(h.params, h.io);
  h.pending[0]({ output: "failed", isError: true });
  await Promise.resolve();
  await assert.rejects(h.svc.spawn({ ...h.params, depends_on: [a.id] }, h.io), /did not complete successfully/);
  assert.equal(h.pending.length, 1);
  h.svc.dispose();
});

test("R-H6b interactive implicit exit is completion, not verified success", async () => {
  const h = setup();
  const io = { ...h.io, transport: "interactive" as const };
  const a = await h.svc.spawn(h.params, io);
  await h.svc.childExited(a.id);
  assert.match(h.events[0], /ended without calling close_thread/);
  await h.svc.spawn({ ...h.params, depends_on: [a.id] }, io);
  h.svc.dispose();
});
