import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/lib/config.ts";
import { Emitter } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { ThreadService, type ThreadIO } from "../extensions/lib/thread-service.ts";
import { identify, ThreadFiles } from "../extensions/lib/threads.ts";

function setup(maxLaunches = 0, windowSeconds = 0) {
  const dir = mkdtempSync(join(tmpdir(), "launch-budget-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const config = structuredClone(DEFAULT_CONFIG);
  config.threads.launchBudget = { maxLaunches, windowSeconds };
  const emitter = new Emitter({ send: () => {}, spillDir: dir, maxChars: 4000, seenCap: 100, logger });
  let now = 0;
  const create = () => new ThreadService({ identity: identify({}, files), files, sandboxes: [], emitter, config, logger, now: () => now });
  let calls = 0;
  const io: ThreadIO = {
    cwd: dir,
    launch: async () => {
      calls++;
      return {};
    },
    launchDetached: () => {
      calls++;
      return { done: new Promise(() => {}), abort: () => {} };
    },
    sendToChild: async () => {},
  };
  const params = { instructions: "work", child_of: ["root"], fresh_context: true };
  return {
    create,
    io,
    params,
    files,
    config,
    setTime: (n: number) => {
      now = n;
    },
    calls: () => calls,
  };
}

for (const transport of ["interactive", "subagents"] as const) {
  test(`R-RLM4 ${transport} limits total launches even after completion`, async () => {
    const h = setup(1);
    const svc = h.create();
    const io = { ...h.io, transport };
    const child = await svc.spawn(h.params, io);
    await svc.childExited(child.id);
    await assert.rejects(svc.spawn({ ...h.params, sandbox: true }, io), /maximum launches/);
    assert.equal(h.calls(), 1);
    svc.dispose();
  });
}

test("R-RLM4 in-flight reservations cannot bypass the cap and failures release them", async () => {
  const h = setup(1);
  const svc = h.create();
  let reject!: (e: Error) => void;
  const pending = svc.spawn(h.params, {
    ...h.io,
    launch: () =>
      new Promise((_, r) => {
        reject = r;
      }),
  });
  await assert.rejects(svc.spawn(h.params, h.io), /maximum launches/);
  reject(new Error("launch failed"));
  await assert.rejects(pending, /launch failed/);
  await svc.spawn(h.params, h.io);
  svc.dispose();
});

test("R-RLM4 a bookkeeping failure after launch still consumes the launch budget", async () => {
  const h = setup(1);
  const svc = h.create();
  const write = h.files.write.bind(h.files);
  let writes = 0;
  h.files.write = (record) => {
    if (++writes === 2) throw new Error("bookkeeping failed");
    write(record);
  };
  const child = await svc.spawn(h.params, h.io);
  assert.equal(svc.runningCount(), 1);
  await svc.childExited(child.id);
  await assert.rejects(svc.spawn(h.params, h.io), /maximum launches/);
  assert.equal(h.calls(), 1);
  svc.dispose();
});

test("R-H12 bookkeeping failure retains adaptive concurrency until child closes", async () => {
  const h = setup();
  h.config.threads.adaptiveConcurrency.enabled = true;
  h.config.threads.adaptiveConcurrency.initial = 1;
  h.config.threads.adaptiveConcurrency.min = 1;
  const svc = h.create();
  const write = h.files.write.bind(h.files);
  let writes = 0;
  h.files.write = (record) => {
    if (++writes === 2) throw new Error("bookkeeping failed");
    write(record);
  };
  const child = await svc.spawn(h.params, h.io);
  await assert.rejects(svc.spawn(h.params, h.io), /concurrency limit/);
  await svc.childExited(child.id);
  await svc.spawn(h.params, h.io);
  svc.dispose();
});

test("R-RLM4 detached launch failure releases its reservation", async () => {
  const h = setup(1);
  const svc = h.create();
  const io = { ...h.io, transport: "subagents" as const };
  await assert.rejects(
    svc.spawn(h.params, {
      ...io,
      launchDetached: () => {
        throw new Error("detached failed");
      },
    }),
    /detached failed/,
  );
  await svc.spawn(h.params, io);
  svc.dispose();
});

test("R-RLM4 window starts at first admission, expires at boundary, and resets with a new service", async () => {
  const h = setup(0, 2);
  const svc = h.create();
  h.setTime(100000);
  await svc.spawn(h.params, h.io);
  h.setTime(101999);
  await svc.spawn(h.params, h.io);
  h.setTime(102000);
  await assert.rejects(svc.spawn(h.params, h.io), /window has ended/);
  const next = h.create();
  await next.spawn(h.params, h.io);
  svc.dispose();
  next.dispose();
});

test("R-RLM4 failed first launch resets the window; disabled caps do not limit launches", async () => {
  const h = setup(0, 1);
  const svc = h.create();
  await assert.rejects(
    svc.spawn(h.params, {
      ...h.io,
      launch: async () => {
        throw new Error("failed");
      },
    }),
    /failed/,
  );
  h.setTime(2000);
  await svc.spawn(h.params, h.io);
  svc.dispose();
  const unlimited = setup();
  const other = unlimited.create();
  for (let i = 0; i < 5; i++) await other.spawn(unlimited.params, unlimited.io);
  other.dispose();
});

test("R-RLM4 invalid config limits are reported and rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-config-"));
  writeFileSync(join(dir, "infinity.json"), JSON.stringify({ threads: { launchBudget: { maxLaunches: 1.5, windowSeconds: -1 } } }));
  const loaded = loadConfig(dir, memoryLogger(), dir);
  assert.equal(loaded.problems.length, 2);
  assert.deepEqual(loaded.config.threads.launchBudget, { maxLaunches: 0, windowSeconds: 0 });
});
