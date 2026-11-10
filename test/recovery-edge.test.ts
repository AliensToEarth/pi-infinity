import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { Emitter, type OutgoingMessage } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import type { SandboxBackend } from "../extensions/lib/sandbox/types.ts";
import { ThreadService, type ThreadIO } from "../extensions/lib/threads/service.ts";
import { appendInbox, inboxPath } from "../extensions/lib/threads/inbox.ts";
import { ThreadFiles, identify, type ThreadIdentity, type ThreadRecord } from "../extensions/lib/threads/protocol.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "recovery-edge-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const messages: OutgoingMessage[] = [];
  const emitter = new Emitter({ send: (m) => messages.push(m), spillDir: dir, maxChars: 10000, seenCap: 100, logger });
  const services: ThreadService[] = [];
  const make = (opts: { session?: string; identity?: ThreadIdentity; backends?: SandboxBackend[]; limited?: boolean } = {}) => {
    const service = new ThreadService({
      identity: opts.identity ?? identify({}, files),
      files,
      parentSession: opts.session ?? "parent",
      sandboxes: opts.backends ?? [],
      emitter,
      logger,
      config: opts.limited
        ? {
            ...DEFAULT_CONFIG,
            threads: {
              ...DEFAULT_CONFIG.threads,
              adaptiveConcurrency: { ...DEFAULT_CONFIG.threads.adaptiveConcurrency, enabled: true, initial: 1, min: 1, max: 1 },
            },
          }
        : DEFAULT_CONFIG,
      pollMs: 10000,
    });
    services.push(service);
    return service;
  };
  t.after(() => {
    for (const service of services) service.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const io = (sessionFile = join(dir, "child")): ThreadIO => ({
    cwd: dir,
    callId: "original-call",
    launch: async () => ({ sessionFile }),
    sendToChild: async () => {},
  });
  return { dir, files, messages, make, io };
}

function backend(dir: string, commitAll?: SandboxBackend["commitAll"]): SandboxBackend {
  return {
    name: "fake",
    detect: async () => ({ repoRoot: dir }),
    create: async ({ id }) => ({ id, branch: `branch-${id}`, path: join(dir, id), base: "main", repoRoot: dir }),
    commitAll: commitAll ?? (async () => ({ committed: false })),
    diffStat: async () => "one file",
    squashInto: async () => ({ ok: true, filesChanged: 1 }),
    remove: async () => {},
    list: async () => [],
    pruneMerged: async () => [],
  };
}

test("R-H offline reports and close replay in order with original call attribution", async (t) => {
  const f = fixture(t);
  const first = f.make();
  const session = join(f.dir, "child");
  const { id } = await first.spawn({ instructions: "work", child_of: ["root"] }, f.io(session));
  first.dispose();
  appendInbox(inboxPath(session), { type: "report", seq: 0, text: "first offline", at: 1 });
  appendInbox(inboxPath(session), { type: "report", seq: 1, text: "second offline", at: 2 });
  appendInbox(inboxPath(session), { type: "closed", seq: 2, text: "final offline", at: 3 });
  const resumed = f.make();
  resumed.drainAll();
  assert.deepEqual(
    f.messages.map((m) => m.details.source.callId),
    ["original-call", "original-call", "original-call"],
  );
  assert.match(JSON.stringify(f.messages), /first offline.*second offline.*final offline/);
  assert.equal(f.files.read(id), null);
  resumed.drainAll();
  assert.equal(f.messages.length, 3);
});

test("R-H recovered children reserve adaptive concurrency until close", async (t) => {
  const f = fixture(t);
  const first = f.make({ limited: true });
  const { id } = await first.spawn({ instructions: "work", child_of: ["root"] }, f.io());
  first.dispose();
  const resumed = f.make({ limited: true });
  await assert.rejects(resumed.spawn({ instructions: "another", child_of: ["root"] }, f.io(join(f.dir, "other"))), /concurrency limit/);
  appendInbox(inboxPath(join(f.dir, "child")), { type: "closed", seq: 0, text: "done", at: 1 });
  resumed.drainAll();
  assert.equal(f.files.read(id), null);
  await resumed.spawn({ instructions: "another", child_of: ["root"] }, f.io(join(f.dir, "other")));
});

test("R-H sandbox recovery requires its backend and preserves the branch on close", async (t) => {
  const f = fixture(t);
  let removes = 0;
  let commits = 0;
  const b = backend(f.dir, async () => {
    commits++;
    return { committed: true };
  });
  b.remove = async () => {
    removes++;
  };
  const first = f.make({ backends: [b] });
  const { id } = await first.spawn({ instructions: "work", child_of: ["root"], sandbox: true }, f.io());
  first.dispose();
  const missing = f.make();
  assert.equal(missing.runningCount(), 0);
  assert.ok(f.files.read(id));
  missing.dispose();
  appendInbox(inboxPath(join(f.dir, "child")), { type: "closed", seq: 0, text: "done", at: 1 });
  const resumed = f.make({ backends: [b] });
  resumed.drainAll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resumed.runningCount(), 0);
  assert.equal(removes, 0);
  assert.equal(commits, DEFAULT_CONFIG.sandbox.autoCommit ? 1 : 0);
  assert.match(JSON.stringify(f.messages), /branch-/);
  assert.equal(f.files.read(id), null);
});

test("R-S5 nested jj squash reports uncommitted and no-op results accurately", async (t) => {
  for (const commit of [false, true]) {
    await t.test(`commit: ${commit}`, async (t) => {
      const f = fixture(t);
      const b = { ...backend(f.dir), name: "jj" };
      b.squashInto = async (_target, _source, options) => {
        assert.equal(options.commit, commit);
        return { ok: true, filesChanged: commit ? 0 : 1 };
      };
      const parent: ThreadRecord = {
        id: "t-aaaaaa",
        parentId: "root",
        stack: ["root", "t-aaaaaa"],
        instructions: "parent",
        fresh: true,
        createdAt: 1,
        status: "running",
        sandbox: { id: "t-aaaaaa", branch: "parent", path: f.dir, base: "base", repoRoot: f.dir },
      };
      const identity: ThreadIdentity = { id: parent.id, stack: parent.stack, parentId: "root", inboxFile: null, record: parent };
      const service = f.make({ identity, backends: [b] });
      const { id } = await service.spawn({ instructions: "child", child_of: parent.stack, sandbox: true }, f.io());
      await service.childExited(id);
      const message = await service.squash(id, { commit }, f.io());
      assert.match(message, commit ? /no changes to commit/ : /left in your working-copy change/);
    });
  }
});

test("R-H recovery isolates nested parents and rejects malformed ancestry", (t) => {
  const f = fixture(t);
  const parent = "t-aaaaaa";
  const child = "t-bbbbbb";
  const base: ThreadRecord = {
    id: child,
    parentId: parent,
    stack: ["root", parent, child],
    instructions: "nested",
    fresh: false,
    createdAt: 1,
    status: "running",
    parentSession: "same",
  };
  f.files.write(base);
  const identity: ThreadIdentity = { id: parent, stack: ["root", parent], parentId: "root", inboxFile: null, record: null };
  assert.equal(f.make({ session: "same" }).runningCount(), 0);
  assert.equal(f.make({ session: "different", identity }).runningCount(), 0);
  const nested = f.make({ session: "same", identity });
  assert.deepEqual(
    nested.list().map((r) => r.id),
    [child],
  );
  nested.dispose();
  f.files.write({ ...base, stack: ["root", "t-cccccc", child] });
  assert.equal(f.make({ session: "same", identity }).runningCount(), 0);
});

test("R-H failed interactive launch removes its recovery record and releases admission", async (t) => {
  const f = fixture(t);
  const service = f.make({ limited: true });
  await assert.rejects(
    service.spawn(
      { instructions: "fail", child_of: ["root"] },
      {
        ...f.io(),
        launch: async () => {
          throw new Error("launch failed");
        },
      },
    ),
    /launch failed/,
  );
  assert.equal(f.files.list(memoryLogger()).length, 0);
  await service.spawn({ instructions: "retry", child_of: ["root"] }, f.io());
});

test("R-H disposal during sandbox finalization leaves recovery to replacement service", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const b = backend(f.dir, async () => {
    calls++;
    if (calls === 1) {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return { committed: true };
  });
  // Force an asynchronous close even when auto-commit is disabled.
  b.diffStat = async () => {
    if (!DEFAULT_CONFIG.sandbox.autoCommit && calls++ === 0) {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return "changes";
  };
  const first = f.make({ backends: [b] });
  const { id } = await first.spawn({ instructions: "work", child_of: ["root"], sandbox: true }, f.io());
  appendInbox(inboxPath(join(f.dir, "child")), { type: "closed", seq: 0, text: "done", at: 1 });
  first.drainAll();
  await entered;
  first.dispose();
  const resumed = f.make({ backends: [b] });
  resumed.drainAll();
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.files.read(id), null);
  assert.equal(f.messages.length, 1);
  assert.equal(resumed.runningCount(), 0);
});
