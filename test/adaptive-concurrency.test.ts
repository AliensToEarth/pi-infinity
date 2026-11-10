import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdaptiveConcurrency } from "../extensions/lib/adaptive-concurrency.ts";
import { DEFAULT_CONFIG, loadConfig } from "../extensions/lib/config.ts";
import { Emitter } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { ThreadService, type ThreadIO } from "../extensions/lib/thread-service.ts";
import { identify, ThreadFiles } from "../extensions/lib/threads.ts";

test("R-H11 adaptive limits increase on success and decrease on failure within bounds", () => {
  const limiter = new AdaptiveConcurrency({ enabled: true, min: 1, initial: 2, max: 3, successesToIncrease: 2, decreaseFactor: 0.5 });
  limiter.acquire();
  limiter.acquire();
  assert.throws(() => limiter.acquire(), /limit reached/);
  limiter.complete("ok");
  limiter.acquire();
  limiter.complete("ok");
  limiter.acquire();
  limiter.acquire();
  assert.throws(() => limiter.acquire(), /limit reached/);
  limiter.complete("error");
  assert.throws(() => limiter.acquire(), /limit reached/);
  limiter.complete("ok");
  limiter.complete("ok");
  limiter.acquire();
  limiter.complete("error");
  limiter.acquire();
  assert.throws(() => limiter.acquire(), /limit reached/);
  limiter.complete("ok");
});

test("R-H11 disabled limiter preserves unlimited admission", () => {
  const limiter = new AdaptiveConcurrency(DEFAULT_CONFIG.threads.adaptiveConcurrency);
  for (let i = 0; i < 100; i++) limiter.acquire();
  for (let i = 0; i < 100; i++) limiter.complete("error");
});

test("R-H11 invalid adaptive calibration is reported and reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "adaptive-config-"));
  writeFileSync(join(dir, "infinity.json"), JSON.stringify({ threads: { adaptiveConcurrency: { enabled: true, min: 4, initial: 2 } } }));
  const loaded = loadConfig(dir, memoryLogger(), dir);
  assert.match(loaded.problems.join(" "), /adaptiveConcurrency/);
  assert.deepEqual(loaded.config.threads.adaptiveConcurrency, DEFAULT_CONFIG.threads.adaptiveConcurrency);
});

test("R-H8 R-H11 shutdown during interactive launch retains the child record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adaptive-shutdown-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const config = structuredClone(DEFAULT_CONFIG);
  config.threads.adaptiveConcurrency.enabled = true;
  const events: string[] = [];
  const emitter = new Emitter({ send: (m) => events.push(m.content), spillDir: dir, maxChars: 4000, seenCap: 100, logger });
  const service = new ThreadService({ identity: identify({}, files), files, sandboxes: [], emitter, config, logger });
  let resolve!: (value: { sessionFile?: string }) => void;
  let id = "";
  const io: ThreadIO = {
    cwd: dir,
    launch: ({ name }) => {
      id = name;
      return new Promise((r) => {
        resolve = r;
      });
    },
    sendToChild: async () => {},
  };
  const pending = service.spawn({ instructions: "work", child_of: ["root"] }, io);
  assert.ok(existsSync(files.pathFor(id)));
  service.dispose();
  resolve({ sessionFile: join(dir, "session.jsonl") });
  await assert.rejects(pending, /session has ended/);
  assert.equal(files.read(id)?.sessionFile, join(dir, "session.jsonl"));
  assert.deepEqual(service.list(), []);
  assert.deepEqual(events, []);
});

test("R-H8 shutdown during detached launch aborts without registering a child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "detached-shutdown-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const emitter = new Emitter({ send: () => {}, spillDir: dir, maxChars: 4000, seenCap: 100, logger });
  const service = new ThreadService({ identity: identify({}, files), files, sandboxes: [], emitter, config: DEFAULT_CONFIG, logger });
  let aborted = false;
  const io: ThreadIO = {
    cwd: dir,
    transport: "subagents",
    launch: async () => ({}),
    sendToChild: async () => {},
    launchDetached: () => {
      service.dispose();
      return {
        done: Promise.resolve({ output: "done", isError: false }),
        abort: () => {
          aborted = true;
        },
      };
    },
  };
  await assert.rejects(service.spawn({ instructions: "work", child_of: ["root"], fresh_context: true }, io), /session has ended/);
  assert.equal(aborted, true);
  assert.deepEqual(service.list(), []);
});

test("R-H11 reserves concurrent launches and releases after failed launch or child exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adaptive-service-"));
  const files = new ThreadFiles(dir);
  const logger = memoryLogger();
  const config = structuredClone(DEFAULT_CONFIG);
  config.threads.adaptiveConcurrency = { enabled: true, min: 1, initial: 1, max: 2, successesToIncrease: 1, decreaseFactor: 0.5 };
  const emitter = new Emitter({ send: () => {}, spillDir: dir, maxChars: 4000, seenCap: 100, logger });
  const service = new ThreadService({ identity: identify({}, files), files, sandboxes: [], emitter, config, logger });
  let resolve!: (value: { sessionFile?: string }) => void;
  const io: ThreadIO = {
    cwd: dir,
    launch: () =>
      new Promise((r) => {
        resolve = r;
      }),
    sendToChild: async () => {},
  };
  const params = { instructions: "work", child_of: ["root"] };
  const pending = service.spawn(params, io);
  await assert.rejects(service.spawn(params, io), /limit reached/);
  resolve({});
  const first = await pending;
  await service.childExited(first.id);
  const failed: ThreadIO = {
    ...io,
    launch: async () => {
      throw new Error("launch failed");
    },
  };
  await assert.rejects(service.spawn(params, failed), /launch failed/);
  const second = service.spawn(params, io);
  resolve({});
  const result = await second;
  await service.childExited(result.id);
  service.dispose();
});
