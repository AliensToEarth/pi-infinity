import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryLogger } from "../extensions/lib/log.ts";
import { MAX_TIMEOUT_MS, TimerStore, zonedTimeToUtcMs } from "../extensions/lib/timers.ts";
import type { TimerEntry, TimerRecord } from "../extensions/lib/timers.ts";

class FakeClock {
  nowMs: number;
  constructor(start: number) {
    this.nowMs = start;
  }
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

class FakeTimeouts {
  requested: number[] = [];
  timers: FakeTimer[] = [];
  cleared: FakeTimer[] = [];
  setTimeout(fn: () => void, ms: number): FakeTimer {
    const timer: FakeTimer = { fn, ms, cleared: false };
    this.requested.push(ms);
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(handle: unknown): void {
    const timer = handle as FakeTimer;
    if (timer !== null && typeof timer === "object") {
      timer.cleared = true;
      this.cleared.push(timer);
    }
  }
}

interface HarnessOpts {
  max?: number;
  start?: number;
  fireError?: string;
}

interface Harness {
  clock: FakeClock;
  timeouts: FakeTimeouts;
  entries: TimerEntry[];
  fired: Array<{ timer: TimerRecord; lateMs: number }>;
  logger: ReturnType<typeof memoryLogger>;
  store: TimerStore;
}

function makeStore(opts: HarnessOpts = {}): Harness {
  const clock = new FakeClock(opts.start ?? 0);
  const timeouts = new FakeTimeouts();
  const entries: TimerEntry[] = [];
  const fired: Array<{ timer: TimerRecord; lateMs: number }> = [];
  const logger = memoryLogger();
  let idSeq = 0;
  const store = new TimerStore({
    now: () => clock.now(),
    setTimeout: (fn, ms) => timeouts.setTimeout(fn, ms),
    clearTimeout: (handle) => timeouts.clearTimeout(handle),
    persist: (entry) => {
      entries.push(entry);
    },
    fire: (timer, lateMs) => {
      if (opts.fireError !== undefined) throw new Error(opts.fireError);
      fired.push({ timer, lateMs });
    },
    newId: () => {
      idSeq += 1;
      return `t${idSeq}`;
    },
    max: opts.max ?? 8,
    logger,
  });
  return { clock, timeouts, entries, fired, logger, store };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

test("R-T1 schedule registers a timer at once and persists the set entry", () => {
  const h = makeStore({ start: 1000 });
  const timer = h.store.schedule(5000, "wake me", "sleep");
  assert.equal(timer.id, "t1");
  assert.equal(timer.kind, "sleep");
  assert.equal(timer.setAt, 1000);
  assert.equal(timer.dueAt, 6000);
  assert.equal(timer.note, "wake me");
  assert.equal(h.fired.length, 0);
  assert.deepEqual(h.timeouts.requested, [5000]);
  assert.deepEqual(h.entries, [{ op: "set", timer }]);
  assert.deepEqual(h.store.list(), [timer]);
});

test("R-T1 scheduleAt with a past dueAt fires immediately and persists set then fired", () => {
  const h = makeStore({ start: 10000 });
  const timer = h.store.scheduleAt(4000, "already past");
  assert.equal(timer.kind, "sleep_until");
  assert.equal(timer.dueAt, 4000);
  assert.equal(h.timeouts.requested.length, 0);
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0].timer.id, timer.id);
  assert.equal(h.fired[0].lateMs, 6000);
  assert.deepEqual(
    h.entries.map((e) => e.op),
    ["set", "fired"],
  );
  assert.deepEqual(h.store.list(), []);
});

test("R-T5 delays above MAX_TIMEOUT_MS are chained into hops", () => {
  const h = makeStore({ start: 0 });
  const timer = h.store.schedule(MAX_TIMEOUT_MS * 2 + 5000);
  assert.deepEqual(h.timeouts.requested, [MAX_TIMEOUT_MS]);
  h.clock.advance(MAX_TIMEOUT_MS);
  h.timeouts.timers[0].fn();
  assert.deepEqual(h.timeouts.requested, [MAX_TIMEOUT_MS, MAX_TIMEOUT_MS]);
  h.clock.advance(MAX_TIMEOUT_MS);
  h.timeouts.timers[1].fn();
  assert.deepEqual(h.timeouts.requested, [MAX_TIMEOUT_MS, MAX_TIMEOUT_MS, 5000]);
  assert.equal(h.fired.length, 0);
  h.clock.advance(5000);
  h.timeouts.timers[2].fn();
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0].timer.id, timer.id);
  assert.equal(h.fired[0].lateMs, 0);
  assert.deepEqual(
    h.entries.map((e) => e.op),
    ["set", "fired"],
  );
  assert.deepEqual(h.store.list(), []);
});

test("R-T5 a 7 day sleep arms a single native timeout", () => {
  const h = makeStore({ start: 0 });
  h.store.schedule(7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(h.timeouts.requested, [604800000]);
});

test("R-T7 schedule throws a clear error at the pending timer limit", () => {
  const h = makeStore({ max: 2 });
  h.store.schedule(1000);
  h.store.schedule(2000);
  assert.equal(h.store.list().length, 2);
  assert.throws(() => h.store.schedule(3000), /timer limit reached: at most 2 pending timers/);
  h.store.cancel("t1");
  const timer = h.store.schedule(3000);
  assert.equal(timer.dueAt, 3000);
});

test("schedule and scheduleAt reject invalid inputs", () => {
  const h = makeStore();
  for (const bad of [-1, -0.5, NaN, Infinity, -Infinity, "100", null, undefined]) {
    assert.throws(() => h.store.schedule(bad as number), /invalid delay/, `delay ${String(bad)}`);
  }
  for (const bad of [NaN, Infinity, "1000", null]) {
    assert.throws(() => h.store.scheduleAt(bad as number), /invalid due time/, `dueAt ${String(bad)}`);
  }
  assert.throws(() => h.store.schedule(100, "n", "nap" as never), /invalid timer kind/);
  assert.equal(h.entries.length, 0);
});

test("a timer fires at most once and reports its lateness", () => {
  const h = makeStore({ start: 100 });
  h.store.schedule(1000);
  h.clock.advance(1250);
  h.timeouts.timers[0].fn();
  assert.equal(h.fired.length, 1);
  assert.equal(h.fired[0].timer.id, "t1");
  assert.equal(h.fired[0].lateMs, 250);
  assert.deepEqual(
    h.entries.map((e) => e.op),
    ["set", "fired"],
  );
  assert.deepEqual(h.store.list(), []);
  // A stale wake for the same handle is a no-op.
  h.timeouts.timers[0].fn();
  assert.equal(h.fired.length, 1);
  assert.equal(h.entries.length, 2);
});

test("a throwing fire callback is logged and does not stop other timers", () => {
  const h = makeStore({ start: 0, fireError: "boom" });
  h.store.schedule(100);
  h.store.schedule(200);
  h.clock.advance(100);
  h.timeouts.timers[0].fn();
  h.clock.advance(100);
  h.timeouts.timers[1].fn();
  assert.equal(h.logger.lines.length, 2);
  assert.ok(h.logger.lines.every((line) => line.includes("boom")));
  assert.deepEqual(
    h.entries.map((e) => e.op),
    ["set", "set", "fired", "fired"],
  );
  assert.deepEqual(h.store.list(), []);
});

test("cancel is idempotent and persists one cancelled entry", () => {
  const h = makeStore({ start: 50 });
  const timer = h.store.schedule(1000, "a");
  assert.equal(h.store.cancel(timer.id), true);
  assert.equal(h.timeouts.timers[0].cleared, true);
  assert.deepEqual(
    h.entries.map((e) => e.op),
    ["set", "cancelled"],
  );
  assert.deepEqual(h.store.list(), []);
  assert.equal(h.store.cancel(timer.id), false);
  assert.equal(h.store.cancel("no such id"), false);
  assert.equal(h.entries.length, 2);
  // A cleared timer never fires.
  h.timeouts.timers[0].fn();
  assert.equal(h.fired.length, 0);
});

test("cancelAll cancels every pending timer and returns the count", () => {
  const h = makeStore({ start: 0 });
  h.store.schedule(300);
  h.store.schedule(100);
  h.store.schedule(200);
  assert.equal(h.store.cancelAll(), 3);
  assert.equal(h.timeouts.cleared.length, 3);
  assert.deepEqual(h.store.list(), []);
  assert.deepEqual(
    h.entries.map((e) => e.op),
    ["set", "set", "set", "cancelled", "cancelled", "cancelled"],
  );
});

test("list returns pending timers sorted by dueAt", () => {
  const h = makeStore({ start: 0 });
  h.store.schedule(300, "third");
  h.store.schedule(100, "first");
  h.store.schedule(200, "second");
  assert.deepEqual(
    h.store.list().map((t) => t.dueAt),
    [100, 200, 300],
  );
  assert.deepEqual(
    h.store.list().map((t) => t.id),
    ["t2", "t3", "t1"],
  );
});

test("dispose clears every native handle and persists nothing", () => {
  const h = makeStore({ start: 0 });
  h.store.schedule(1000);
  h.store.schedule(2000);
  h.store.dispose();
  assert.equal(h.timeouts.cleared.length, 2);
  assert.deepEqual(h.store.list(), []);
  assert.deepEqual(
    h.entries.map((e) => e.op),
    ["set", "set"],
  );
  // Stale wakes after dispose are no-ops.
  h.timeouts.timers[0].fn();
  h.timeouts.timers[1].fn();
  assert.equal(h.fired.length, 0);
  assert.equal(h.entries.length, 2);
});

test("R-T4 restore re-arms pending timers and fires overdue ones at once", () => {
  const first = makeStore({ start: 0 });
  first.store.schedule(100, "fires in the first store");
  first.store.schedule(200, "gets cancelled");
  first.store.schedule(5000, "overdue in the second store");
  first.store.schedule(100000, "still pending after restore");
  first.clock.advance(100);
  first.timeouts.timers[0].fn();
  first.store.cancel("t2");
  const entries = [...first.entries];
  assert.deepEqual(
    entries.map((e) => e.op),
    ["set", "set", "set", "set", "fired", "cancelled"],
  );

  const second = makeStore({ start: 6000 });
  assert.deepEqual(second.store.restore(entries), { rearmed: 1, firedLate: 1 });
  assert.equal(second.fired.length, 1);
  assert.equal(second.fired[0].timer.id, "t3");
  assert.equal(second.fired[0].lateMs, 1000);
  assert.deepEqual(
    second.entries.map((e) => e.op),
    ["fired"],
  );
  assert.deepEqual(
    second.store.list().map((t) => t.id),
    ["t4"],
  );
  assert.deepEqual(second.timeouts.requested, [100000 - 6000]);
  // The re-armed timer fires when its native timeout fires.
  second.clock.advance(100000 - 6000);
  second.timeouts.timers[0].fn();
  assert.equal(second.fired.length, 2);
  assert.equal(second.fired[1].timer.id, "t4");
  assert.equal(second.fired[1].lateMs, 0);
  assert.deepEqual(
    second.entries.map((e) => e.op),
    ["fired", "fired"],
  );
});

test("R-T4 replaying the same entries twice fires no timer twice", () => {
  const first = makeStore({ start: 0 });
  first.store.schedule(100);
  first.store.schedule(5000);
  first.clock.advance(100);
  first.timeouts.timers[0].fn();
  const entries = [...first.entries];

  const second = makeStore({ start: 6000 });
  assert.deepEqual(second.store.restore(entries), { rearmed: 0, firedLate: 1 });
  assert.deepEqual(second.store.restore(entries), { rearmed: 0, firedLate: 0 });
  assert.equal(second.fired.length, 1);
  assert.deepEqual(
    second.entries.map((e) => e.op),
    ["fired"],
  );
  assert.deepEqual(second.store.list(), []);
});

test("R-T4 restore of an empty entry branch is a no-op", () => {
  const h = makeStore({ start: 100 });
  assert.deepEqual(h.store.restore([]), { rearmed: 0, firedLate: 0 });
  assert.equal(h.fired.length, 0);
  assert.equal(h.entries.length, 0);
});

test("R-T6 converts wall clock times in fixed and DST zones", () => {
  const cases: Array<[string, string, string, string]> = [
    ["2026-03-08", "01:30", "America/New_York", "2026-03-08T06:30:00.000Z"],
    ["2026-03-08", "03:30", "America/New_York", "2026-03-08T07:30:00.000Z"],
    ["2026-11-01", "12:00", "America/New_York", "2026-11-01T17:00:00.000Z"],
    ["2026-06-21", "12:00", "Europe/London", "2026-06-21T11:00:00.000Z"],
    ["2026-01-15", "12:00", "Europe/London", "2026-01-15T12:00:00.000Z"],
    ["2024-02-29", "00:00", "UTC", "2024-02-29T00:00:00.000Z"],
    ["0000-01-01", "12:00", "UTC", "0000-01-01T12:00:00.000Z"],
    ["0001-01-01", "00:00", "UTC", "0001-01-01T00:00:00.000Z"],
    ["2026-07-04", "14:45", "Asia/Kolkata", "2026-07-04T09:15:00.000Z"],
    ["2026-07-04", "12:34:56", "UTC", "2026-07-04T12:34:56.000Z"],
    ["2026-01-15", "09:00", "Pacific/Auckland", "2026-01-14T20:00:00.000Z"],
    ["2026-07-15", "09:00", "Pacific/Auckland", "2026-07-14T21:00:00.000Z"],
  ];
  for (const [date, time, zone, want] of cases) {
    assert.equal(iso(zonedTimeToUtcMs(date, time, zone)), want, `${date} ${time} ${zone}`);
  }
});

test("R-T6 a spring forward gap moves forward by the gap", () => {
  const cases: Array<[string, string, string, string]> = [
    ["2026-03-08", "02:30", "America/New_York", "2026-03-08T07:30:00.000Z"],
    ["2026-03-29", "01:30", "Europe/London", "2026-03-29T01:30:00.000Z"],
    ["2026-09-27", "02:30", "Pacific/Auckland", "2026-09-26T14:30:00.000Z"],
    ["2011-12-30", "12:00", "Pacific/Apia", "2011-12-30T22:00:00.000Z"],
  ];
  for (const [date, time, zone, want] of cases) {
    assert.equal(iso(zonedTimeToUtcMs(date, time, zone)), want, `${date} ${time} ${zone}`);
  }
});

test("R-T6 a fall back overlap resolves to the earlier instant", () => {
  const cases: Array<[string, string, string, string]> = [
    ["2026-11-01", "01:30", "America/New_York", "2026-11-01T05:30:00.000Z"],
    ["2026-10-25", "01:30", "Europe/London", "2026-10-25T00:30:00.000Z"],
    ["2026-04-05", "02:30", "Pacific/Auckland", "2026-04-04T13:30:00.000Z"],
  ];
  for (const [date, time, zone, want] of cases) {
    assert.equal(iso(zonedTimeToUtcMs(date, time, zone)), want, `${date} ${time} ${zone}`);
  }
});

test("R-T6 rejects invalid dates, times and zones naming the bad input", () => {
  assert.throws(() => zonedTimeToUtcMs("2026-02-30", "12:00", "UTC"), /2026-02-30/);
  assert.throws(() => zonedTimeToUtcMs("2025-02-29", "12:00", "UTC"), /2025-02-29/);
  assert.throws(() => zonedTimeToUtcMs("2026-13-01", "12:00", "UTC"), /2026-13-01/);
  assert.throws(() => zonedTimeToUtcMs("2026-2-08", "12:00", "UTC"), /2026-2-08/);
  assert.throws(() => zonedTimeToUtcMs("2026/02/08", "12:00", "UTC"), /2026\/02\/08/);
  assert.throws(() => zonedTimeToUtcMs("2026-02-08", "24:00", "UTC"), /24:00/);
  assert.throws(() => zonedTimeToUtcMs("2026-02-08", "12:60", "UTC"), /12:60/);
  assert.throws(() => zonedTimeToUtcMs("2026-02-08", "12:34:60", "UTC"), /12:34:60/);
  assert.throws(() => zonedTimeToUtcMs("2026-02-08", "2:30", "UTC"), /2:30/);
  assert.throws(() => zonedTimeToUtcMs("2026-02-08", "12:00", "America/NewYork"), /America\/NewYork/);
  assert.throws(() => zonedTimeToUtcMs("2026-02-08", "12:00", "Not/AZone"), /Not\/AZone/);
});

test("MAX_TIMEOUT_MS is 2^31 - 1", () => {
  assert.equal(MAX_TIMEOUT_MS, 2147483647);
});
