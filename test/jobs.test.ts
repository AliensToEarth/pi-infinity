import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import type { EventInput } from "../extensions/lib/events.ts";
import { JobManager, compileWatch } from "../extensions/lib/jobs.ts";
import { memoryLogger } from "../extensions/lib/log.ts";

function setup(over: Partial<typeof DEFAULT_CONFIG.jobs> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-inf-jobs-"));
  const events: EventInput[] = [];
  const logger = memoryLogger();
  const mgr = new JobManager({
    emit: (e) => void events.push(e),
    logDir: dir,
    config: { ...DEFAULT_CONFIG.jobs, watchDebounceMs: 30, ...over },
    logger,
    killGraceMs: 300,
    closeGraceMs: 200,
  });
  return { dir, events, logger, mgr };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const exits = (events: EventInput[]) => events.filter((e) => e.kind === "job_exit");

test("R-J1 start returns before output and exit emits exactly one job_exit", async () => {
  const { mgr, events } = setup();
  const t0 = Date.now();
  const job = mgr.start({ command: "sleep 0.3; echo hello; echo oops 1>&2", cwd: tmpdir() });
  assert.ok(Date.now() - t0 < 200, "start must not wait");
  assert.equal(job.status, "running");
  await until(() => exits(events).length > 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(exits(events).length, 1);
  const body = exits(events)[0].body;
  assert.match(body, /finished: exited \(exit code 0/);
  assert.match(body, /hello/);
  assert.match(body, /oops/);
  assert.equal(mgr.get(job.id)?.status, "exited");
});

test("R-J3 restarting a manager does not reuse existing job logs", async () => {
  const { mgr, dir, events, logger } = setup();
  const first = mgr.start({ command: "echo old", cwd: tmpdir() });
  await until(() => exits(events).length === 1);
  const restarted = new JobManager({ emit: (e) => void events.push(e), logDir: dir, config: DEFAULT_CONFIG.jobs, logger });
  const second = restarted.start({ command: "echo new", cwd: tmpdir() });
  await until(() => exits(events).length === 2);
  assert.notEqual(second.logPath, first.logPath);
  assert.equal(readFileSync(first.logPath, "utf8"), "old\n");
  assert.equal(restarted.output(second.id, { since: 0 }).text, "new\n");
});

test("R-J4 failing command reports its exit code and log path", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: "echo bad; exit 3", cwd: tmpdir() });
  await until(() => exits(events).length > 0);
  assert.match(exits(events)[0].body, /exit code 3/);
  assert.equal(job.exitCode, 3);
  assert.equal(readFileSync(job.logPath, "utf8"), "bad\n");
});

test("R-J2 and R-J8 cancel kills the whole process group and is idempotent", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: "sh -c 'sleep 30' & sleep 30", cwd: tmpdir() });
  await new Promise((r) => setTimeout(r, 100));
  const first = mgr.cancel(job.id);
  assert.equal(first.alreadyFinished, false);
  await until(() => exits(events).length > 0);
  assert.equal(mgr.get(job.id)?.status, "cancelled");
  const second = mgr.cancel(job.id);
  assert.equal(second.alreadyFinished, true);
  assert.equal(exits(events).length, 1);
});

test("R-J8 repeated cancel, cancelAll and timeout send SIGTERM only once", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
  const signals: string[] = [];
  const events: EventInput[] = [];
  const mgr = new JobManager({
    emit: (event) => void events.push(event),
    logDir: mkdtempSync(join(tmpdir(), "pi-inf-jobs-")),
    config: DEFAULT_CONFIG.jobs,
    logger: memoryLogger(),
    spawn: () => child as unknown as ChildProcess,
    killGroup: (_pid, signal) => void signals.push(signal),
    killGraceMs: 80,
    closeGraceMs: 10,
  });
  const job = mgr.start({ command: "fake", cwd: tmpdir(), timeoutSeconds: 0.02 });
  assert.equal(mgr.cancel(job.id).alreadyFinished, false);
  assert.equal(mgr.cancel(job.id).alreadyFinished, false);
  mgr.cancelAll();
  await until(() => signals.includes("SIGKILL"));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  child.emit("exit", null, "SIGKILL");
  await until(() => exits(events).length === 1);
});

test("R-J8 SIGKILL follows when SIGTERM is ignored", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: "trap '' TERM; while true; do sleep 1; done", cwd: tmpdir() });
  await new Promise((r) => setTimeout(r, 150));
  mgr.cancel(job.id);
  await until(() => exits(events).length > 0, 4000);
  assert.equal(mgr.get(job.id)?.status, "cancelled");
});

test("R-J8 escalation kills a descendant that ignores TERM after the shell exits", async () => {
  const { mgr, dir } = setup();
  const marker = join(dir, "escaped");
  const script = `process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1200)`;
  const job = mgr.start({ command: `node -e ${JSON.stringify(script)} & wait`, cwd: tmpdir() });
  await until(() => mgr.output(job.id, {}).text.includes("ready"));
  mgr.cancel(job.id);
  await until(() => job.status !== "running");
  assert.equal(job.signal, "SIGTERM", "the shell must exit before escalation");
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(existsSync(marker), false, "descendant survived the group cancellation");
});

test("R-J8 unknown id is an error value for the adapter to report", () => {
  const { mgr } = setup();
  assert.throws(() => mgr.cancel("j99"), /unknown job id/);
});

test("R-J5 invalid or oversized watch patterns start nothing", () => {
  const { mgr } = setup();
  assert.throws(() => mgr.start({ command: "echo x", cwd: tmpdir(), watch: ["("] }), /invalid watch pattern/);
  assert.throws(() => compileWatch(["a".repeat(201)]), /longer than 200/);
  assert.throws(() => compileWatch([""]), /must not be empty/);
  assert.equal(mgr.list().length, 0);
});

test("R-J6 matching lines are batched into one event", async () => {
  const { mgr, events } = setup();
  mgr.start({ command: "for i in 1 2 3 4 5; do echo ready-$i; done; echo other", cwd: tmpdir(), watch: ["^ready"] });
  await until(() => exits(events).length > 0);
  const matches = events.filter((e) => e.kind === "job_match");
  assert.equal(matches.length, 1);
  assert.match(matches[0].body, /5 matching lines/);
  assert.doesNotMatch(matches[0].body, /other/);
});

test("R-J6 rate limit suppresses extra match events and exit reports them", async () => {
  const { mgr, events } = setup({ watchEventsPerMin: 2, watchBatchLines: 1 });
  mgr.start({ command: "for i in 1 2 3 4 5; do echo hit-$i; done", cwd: tmpdir(), watch: ["hit"] });
  await until(() => exits(events).length > 0);
  assert.equal(events.filter((e) => e.kind === "job_match").length, 2);
  assert.match(exits(events)[0].body, /matches: 5 total, 3 not delivered/);
  assert.match(exits(events)[0].body, /first match: hit-1/);
  assert.match(exits(events)[0].body, /last match: hit-5/);
});

test("R-J7 associative jobs are not rate limited", async () => {
  const { mgr, events } = setup({ watchEventsPerMin: 1, watchBatchLines: 1 });
  mgr.start({ command: "for i in 1 2 3 4; do echo hit-$i; done", cwd: tmpdir(), watch: ["hit"], associative: true });
  await until(() => exits(events).length > 0);
  assert.equal(events.filter((e) => e.kind === "job_match").length, 4);
});

test("R-J10 job limit gives an actionable error", () => {
  const { mgr } = setup({ max: 1 });
  const job = mgr.start({ command: "sleep 5", cwd: tmpdir() });
  assert.throws(() => mgr.start({ command: "sleep 5", cwd: tmpdir() }), /too many background jobs.*j1/);
  mgr.cancel(job.id);
});

test("R-J4 long timeouts chain timers and stop on cancellation, exit, close or disposal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const max = 2 ** 31 - 1;
  const signals: string[] = [];
  const children: EventEmitter[] = [];
  const mgr = new JobManager({
    emit: () => {},
    logDir: mkdtempSync(join(tmpdir(), "pi-inf-jobs-")),
    config: DEFAULT_CONFIG.jobs,
    logger: memoryLogger(),
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child);
      return child as unknown as ChildProcess;
    },
    killGroup: (_pid, signal) => void signals.push(signal),
  });
  const start = () => mgr.start({ command: "fake", cwd: tmpdir(), timeoutSeconds: (max + 1000) / 1000 });
  const job = start();
  const cancelled = start();
  start();
  start();
  mgr.cancel(cancelled.id);
  children[2].emit("exit", 0, null);
  children[2].emit("close");
  children[3].emit("close");
  t.mock.timers.tick(max);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(job.status, "running");
  t.mock.timers.tick(999);
  assert.equal(signals.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGTERM"]);
  children[0].emit("exit", null, "SIGTERM");
  children[0].emit("close");
  assert.equal(job.status, "timeout");
  const disposed = start();
  mgr.dispose();
  t.mock.timers.tick(max);
  t.mock.timers.tick(1000);
  assert.equal(disposed.status, "running");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);
});

test("R-J4 timeout stops a job and reports it", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: "sleep 30", cwd: tmpdir(), timeoutSeconds: 0.2 });
  await until(() => exits(events).length > 0);
  assert.equal(mgr.get(job.id)?.status, "timeout");
  assert.match(exits(events)[0].body, /timeout/);
});

test("R-J4 timeout stops at shell exit while output pipes remain open", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
  const signals: string[] = [];
  const events: EventInput[] = [];
  const mgr = new JobManager({
    emit: (event) => void events.push(event),
    logDir: mkdtempSync(join(tmpdir(), "pi-inf-jobs-")),
    config: DEFAULT_CONFIG.jobs,
    logger: memoryLogger(),
    spawn: () => child as unknown as ChildProcess,
    killGroup: (_pid, signal) => void signals.push(signal),
    closeGraceMs: 100,
  });
  const job = mgr.start({ command: "done", cwd: tmpdir(), timeoutSeconds: 0.02 });
  child.emit("exit", 0, null);
  await until(() => exits(events).length === 1);
  assert.equal(job.status, "exited");
  assert.deepEqual(signals, []);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("R-J5 long unterminated lines are bounded and counted once", () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
  const events: EventInput[] = [];
  const mgr = new JobManager({
    emit: (event) => void events.push(event),
    logDir: mkdtempSync(join(tmpdir(), "pi-inf-jobs-")),
    config: DEFAULT_CONFIG.jobs,
    logger: memoryLogger(),
    spawn: () => child as unknown as ChildProcess,
  });
  const job = mgr.start({ command: "fake", cwd: tmpdir(), watch: ["needle"] });
  child.stdout.write("x".repeat(65536));
  child.stdout.write("needle\nneedle\n");
  child.emit("exit", 0, null);
  child.emit("close");
  assert.equal(job.lines, 2);
  assert.equal(job.matches, 1);
  assert.equal(readFileSync(job.logPath, "utf8"), "x".repeat(65536) + "needle\nneedle\n");
  child.stdout.destroy();
  child.stderr.destroy();
});

test("R-J3 output arriving after finalization cannot mutate the job or emit matches", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
  const events: EventInput[] = [];
  const mgr = new JobManager({
    emit: (event) => void events.push(event),
    logDir: mkdtempSync(join(tmpdir(), "pi-inf-jobs-")),
    config: { ...DEFAULT_CONFIG.jobs, watchBatchLines: 1 },
    logger: memoryLogger(),
    spawn: () => child as unknown as ChildProcess,
    closeGraceMs: 10,
  });
  const job = mgr.start({ command: "fake", cwd: tmpdir(), watch: ["late"] });
  child.stdout.write("early\n");
  child.emit("exit", 0, null);
  await until(() => exits(events).length === 1);
  child.stdout.write("late\n");
  assert.equal(job.bytes, 6);
  assert.equal(job.lines, 1);
  assert.equal(job.matches, 0);
  assert.equal(events.length, 1);
  assert.equal(readFileSync(job.logPath, "utf8"), "early\n");
  child.stdout.destroy();
  child.stderr.destroy();
});

test("R-J4 spawn failure becomes a job_exit with status error", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: "echo hi", cwd: "/definitely/not/a/dir" });
  await until(() => exits(events).length > 0);
  assert.equal(mgr.get(job.id)?.status, "error");
  assert.equal(exits(events).length, 1);
});

test("R-J9 cancelAll stops every running job", async () => {
  const { mgr, events } = setup();
  mgr.start({ command: "sleep 30", cwd: tmpdir() });
  mgr.start({ command: "sleep 30", cwd: tmpdir() });
  assert.equal(mgr.cancelAll(), 2);
  await until(() => exits(events).length === 2);
  assert.equal(mgr.runningCount(), 0);
});

test("R-J9 dispose preserves shutdown SIGKILL escalation", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: "trap '' TERM; echo ready; while true; do sleep 1; done", cwd: tmpdir() });
  await until(() => mgr.output(job.id, {}).text.includes("ready"));
  mgr.cancelAll();
  mgr.dispose();
  await until(() => exits(events).length === 1, 4000);
  assert.equal(job.status, "cancelled");
  assert.equal(job.signal, "SIGKILL");
});

test("bg_output reads a tail and a byte range", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: "for i in 1 2 3 4 5 6; do echo line-$i; done", cwd: tmpdir() });
  await until(() => exits(events).length > 0);
  assert.equal(mgr.output(job.id, { tail: 2 }).text, "line-5\nline-6");
  const part = mgr.output(job.id, { since: 7, maxBytes: 14 });
  assert.equal(part.text, "line-2\nline-3\n");
  assert.equal(part.nextOffset, 21);
});

test("R-J3 byte ranges preserve UTF-8 characters and offsets", async () => {
  const { mgr, events } = setup();
  const job = mgr.start({ command: `printf '%s' '${"a".repeat(7999)}😀z'`, cwd: tmpdir() });
  await until(() => exits(events).length > 0);
  const first = mgr.output(job.id, { since: 0 });
  assert.equal(first.text, "a".repeat(7999));
  assert.equal(first.nextOffset, 7999);
  const second = mgr.output(job.id, { since: first.nextOffset });
  assert.equal(second.text, "😀z");
  assert.equal(second.nextOffset, 8004);
  assert.equal(mgr.output(job.id, { since: 8000 }).text, "z");
});

test("R-J3 output rejects invalid byte offsets and line counts", () => {
  const { mgr } = setup();
  const job = mgr.start({ command: "true", cwd: tmpdir() });
  for (const since of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => mgr.output(job.id, { since }), /since must be/);
  }
  for (const tail of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => mgr.output(job.id, { tail }), /tail must be/);
  }
});

test("process with a lingering grandchild still finalizes", async () => {
  const { mgr, events } = setup();
  mgr.start({ command: "(sleep 2 &) ; echo started", cwd: tmpdir() });
  await until(() => exits(events).length > 0, 3000);
  assert.match(exits(events)[0].body, /started/);
});
