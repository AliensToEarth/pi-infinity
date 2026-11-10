import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { Emitter, type OutgoingMessage } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { ThreadService, type ThreadIO } from "../extensions/lib/threads/service.ts";
import { appendInbox, inboxPath } from "../extensions/lib/threads/inbox.ts";
import { ThreadFiles, identify } from "../extensions/lib/threads/protocol.ts";
import { reportedPrefixesFromBranch } from "../extensions/runtime.ts";

test("R-H8 a failed close-event journal keeps the record for a later retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-journal-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const messages: OutgoingMessage[] = [];
  const make = (fail: boolean) =>
    new ThreadService({
      identity: identify({}, files),
      files,
      parentSession: "parent",
      sandboxes: [],
      config: DEFAULT_CONFIG,
      logger,
      pollMs: 10000,
      emitter: new Emitter({
        send: (m) => messages.push(m),
        spillDir: dir,
        maxChars: 10000,
        seenCap: 10,
        logger,
        persist: () => {
          if (fail) throw new Error("journal unavailable");
        },
      }),
    });
  const first = make(true);
  const sessionFile = join(dir, "child");
  const { id } = await first.spawn(
    { instructions: "work", child_of: ["root"] },
    {
      cwd: dir,
      launch: async () => ({ sessionFile }),
      sendToChild: async () => {},
    },
  );
  appendInbox(inboxPath(sessionFile), { type: "closed", seq: 0, text: "done", at: 1 });
  first.drainAll();
  assert.ok(files.read(id), "record remains when journaling fails");
  assert.equal(messages.length, 0);
  first.dispose();
  const resumed = make(false);
  resumed.drainAll();
  assert.equal(messages.length, 1);
  assert.equal(files.read(id), null);
  resumed.dispose();
});

test("R-H recovery retains interactive children and replays reports only to the same parent session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const messages: OutgoingMessage[] = [];
  const emitter = new Emitter({ send: (m) => messages.push(m), spillDir: dir, maxChars: 10000, seenCap: 100, logger });
  const make = (session?: string) =>
    new ThreadService({
      identity: identify({}, files),
      files,
      parentSession: session,
      sandboxes: [],
      emitter,
      config: DEFAULT_CONFIG,
      logger,
      pollMs: 10,
    });
  const first = make("parent-a");
  const sessionFile = join(dir, "child");
  const io: ThreadIO = { cwd: dir, callId: "call-1", launch: async () => ({ sessionFile }), sendToChild: async () => {} };
  const { id } = await first.spawn({ instructions: "work", child_of: ["root"] }, io);
  appendInbox(inboxPath(sessionFile), { type: "report", seq: 0, text: "hello", at: 1 });
  first.drainAll();
  first.dispose();
  assert.ok(files.read(id));
  const foreign = make("parent-b");
  const ephemeral = make();
  assert.equal(foreign.list().length, 0);
  assert.equal(ephemeral.list().length, 0);
  const resumed = make("parent-a");
  resumed.drainAll();
  assert.equal(resumed.runningCount(), 1);
  assert.equal(messages.length, 1);
  appendInbox(inboxPath(sessionFile), { type: "closed", seq: 1, text: "done", at: 2 });
  resumed.drainAll();
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.details.source.callId, "call-1");
  assert.equal(files.read(id), null);
  foreign.dispose();
  ephemeral.dispose();
  resumed.dispose();
});

test("R-H8 recovery skips journaled report prefixes beyond the bounded event cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-prefix-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const branch: Array<{ type: string; customType: string; data: unknown }> = [];
  const messages: OutgoingMessage[] = [];
  const emitter = () =>
    new Emitter({
      send: (m) => messages.push(m),
      spillDir: dir,
      maxChars: 10000,
      seenCap: 2,
      logger,
      persist: (data) => branch.push({ type: "custom", customType: "infinity-event-pending", data }),
    });
  const make = (prefixes?: Map<string, number>) =>
    new ThreadService({
      identity: identify({}, files),
      files,
      parentSession: "parent",
      sandboxes: [],
      emitter: emitter(),
      config: DEFAULT_CONFIG,
      logger,
      pollMs: 10000,
      reportedPrefixes: prefixes,
    });
  const first = make();
  const sessionFile = join(dir, "child");
  const { id } = await first.spawn(
    { instructions: "work", child_of: ["root"] },
    {
      cwd: dir,
      launch: async () => ({ sessionFile }),
      sendToChild: async () => {},
    },
  );
  for (let seq = 0; seq < 6; seq++) appendInbox(inboxPath(sessionFile), { type: "report", seq, text: `${seq}`, at: 1 });
  first.drainAll();
  assert.equal(messages.length, 6);
  first.dispose();
  const prefixes = reportedPrefixesFromBranch(branch);
  assert.equal(prefixes.get(id), 5);
  const resumed = make(prefixes);
  resumed.drainAll();
  assert.equal(messages.length, 6);
  appendInbox(inboxPath(sessionFile), { type: "report", seq: 6, text: "new", at: 1 });
  resumed.drainAll();
  assert.equal(messages.length, 7);
  resumed.dispose();
  const rewound = reportedPrefixesFromBranch(branch.slice(0, 2));
  assert.equal(rewound.get(id), 1, "checkpoints follow the selected branch, not the record file");
});

test("R-H recovery discovers a session file written by a launch after shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recovery-late-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const messages: OutgoingMessage[] = [];
  const emitter = new Emitter({ send: (m) => messages.push(m), spillDir: dir, maxChars: 10000, seenCap: 100, logger });
  const make = () =>
    new ThreadService({
      identity: identify({}, files),
      files,
      parentSession: "parent",
      sandboxes: [],
      emitter,
      config: DEFAULT_CONFIG,
      logger,
      pollMs: 10,
    });
  let resolve!: (result: { sessionFile: string }) => void;
  const first = make();
  const pending = first.spawn(
    { instructions: "work", child_of: ["root"] },
    {
      cwd: dir,
      launch: () =>
        new Promise((r) => {
          resolve = r;
        }),
      sendToChild: async () => {},
    },
  );
  first.dispose();
  const resumed = make();
  assert.equal(resumed.runningCount(), 1);
  const sessionFile = join(dir, "child");
  appendInbox(inboxPath(sessionFile), { type: "report", seq: 0, text: "late", at: 1 });
  resolve({ sessionFile });
  await assert.rejects(pending, /session has ended/);
  await new Promise<void>((done) => setTimeout(done, 50));
  resumed.drainAll();
  assert.equal(messages.length, 1);
  resumed.dispose();
});
