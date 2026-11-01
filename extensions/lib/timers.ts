import type { Logger } from "./log.ts";

export type TimerKind = "sleep" | "sleep_until";

export interface TimerRecord {
  id: string;
  kind: TimerKind;
  setAt: number;
  dueAt: number;
  note?: string;
}

export type TimerEntry =
  { op: "set"; timer: TimerRecord } | { op: "fired"; id: string; at: number } | { op: "cancelled"; id: string; at: number };

export interface TimerDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  persist(entry: TimerEntry): void;
  fire(timer: TimerRecord, lateMs: number): void;
  newId(): string;
  max: number;
  logger: Logger;
}

// Native timeouts wrap at 2^31 ms, so longer waits have to be chained (R-T5).
export const MAX_TIMEOUT_MS: number = 2 ** 31 - 1;

interface Pending {
  timer: TimerRecord;
  handle?: unknown;
}

export class TimerStore {
  private readonly deps: TimerDeps;
  private readonly pending = new Map<string, Pending>();
  // Ids this store already fired or cancelled, so a replayed entry branch never runs them twice.
  private readonly done = new Set<string>();

  constructor(deps: TimerDeps) {
    this.deps = deps;
  }

  schedule(delayMs: number, note?: string, kind: TimerKind = "sleep"): TimerRecord {
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(`invalid delay "${String(delayMs)}": expected a finite number of ms >= 0`);
    }
    return this.add(this.deps.now() + delayMs, kind, note);
  }

  scheduleAt(dueAt: number, note?: string, kind: TimerKind = "sleep_until"): TimerRecord {
    if (typeof dueAt !== "number" || !Number.isFinite(dueAt)) {
      throw new Error(`invalid due time "${String(dueAt)}": expected a finite epoch ms number`);
    }
    return this.add(dueAt, kind, note);
  }

  private add(dueAt: number, kind: TimerKind, note?: string): TimerRecord {
    if (kind !== "sleep" && kind !== "sleep_until") {
      throw new Error(`invalid timer kind "${String(kind)}": expected "sleep" or "sleep_until"`);
    }
    if (this.pending.size >= this.deps.max) {
      throw new Error(`timer limit reached: at most ${this.deps.max} pending timers, cancel one first`);
    }
    const timer: TimerRecord = { id: this.deps.newId(), kind, setAt: this.deps.now(), dueAt };
    if (note !== undefined) timer.note = note;
    this.deps.persist({ op: "set", timer });
    this.pending.set(timer.id, { timer });
    this.arm(timer.id);
    return { ...timer };
  }

  // Arms or re-arms one native timeout per pending timer, never longer than the platform
  // limit. A hop wakes up and re-arms for the rest of the wait (R-T5).
  private arm(id: string): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    const delay = p.timer.dueAt - this.deps.now();
    if (delay <= 0) {
      this.fireNow(p.timer);
      return;
    }
    p.handle = this.deps.setTimeout(() => this.onWake(id), Math.min(delay, MAX_TIMEOUT_MS));
  }

  private onWake(id: string): void {
    // A cancelled or fired timer left nothing pending, so a stale wake is a no-op.
    this.arm(id);
  }

  private fireNow(timer: TimerRecord): void {
    const at = this.deps.now();
    this.pending.delete(timer.id);
    this.done.add(timer.id);
    this.deps.persist({ op: "fired", id: timer.id, at });
    // A throwing fire callback must not take down the store or other timers.
    try {
      this.deps.fire(timer, Math.max(0, at - timer.dueAt));
    } catch (err) {
      this.deps.logger.error("timers", err);
    }
  }

  cancel(id: string): boolean {
    const p = this.pending.get(id);
    if (p === undefined) return false;
    this.deps.clearTimeout(p.handle);
    this.pending.delete(id);
    this.done.add(id);
    this.deps.persist({ op: "cancelled", id, at: this.deps.now() });
    return true;
  }

  cancelAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.cancel(id);
    return ids.length;
  }

  list(): TimerRecord[] {
    const records = [...this.pending.values()].map((p) => ({ ...p.timer }));
    records.sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return records;
  }

  restore(entries: TimerEntry[]): { rearmed: number; firedLate: number } {
    // Replays the entry branch in order: a fired or cancelled entry wins over the set
    // entry before it (R-T4).
    const seen = new Map<string, TimerRecord>();
    for (const entry of entries) {
      if (entry.op === "set") {
        const timer = entry.timer;
        if (
          timer === undefined ||
          typeof timer.id !== "string" ||
          typeof timer.kind !== "string" ||
          !Number.isFinite(timer.setAt) ||
          !Number.isFinite(timer.dueAt)
        ) {
          // A corrupted entry must not kill the restore at session start.
          this.deps.logger.error("timers", new Error(`malformed timer set entry: ${JSON.stringify(entry)}`));
          continue;
        }
        if (this.done.has(timer.id) || this.pending.has(timer.id)) continue;
        seen.set(timer.id, timer);
      } else if (entry.op === "fired" || entry.op === "cancelled") {
        const id = entry.id;
        seen.delete(id);
        const p = this.pending.get(id);
        if (p !== undefined) {
          // This store re-armed it, but the entries say it already ended: stop it
          // without writing a duplicate entry.
          this.deps.clearTimeout(p.handle);
          this.pending.delete(id);
        }
        this.done.add(id);
      } else {
        throw new Error(`bug: unknown timer entry op "${String((entry as { op?: unknown }).op)}"`);
      }
    }
    let rearmed = 0;
    let firedLate = 0;
    for (const timer of seen.values()) {
      this.pending.set(timer.id, { timer });
      if (timer.dueAt <= this.deps.now()) {
        // Overdue: deliver the wake-up at once with the lateness in it.
        this.fireNow(timer);
        firedLate++;
      } else {
        this.arm(timer.id);
        rearmed++;
      }
    }
    return { rearmed, firedLate };
  }

  dispose(): void {
    // Shut down: stop every native handle, keep nothing running, write no entries.
    for (const p of this.pending.values()) this.deps.clearTimeout(p.handle);
    this.pending.clear();
  }
}

const HOUR_MS = 3600000;
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = zoneFormatters.get(timeZone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      era: "short",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(timeZone, fmt);
  }
  return fmt;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallOf(timeZone: string, atUtcMs: number): WallTime {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(atUtcMs));
  const num = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) throw new Error(`bug: no ${type} in formatted time`);
    return Number(part.value);
  };
  return {
    year: parts.find((p) => p.type === "era")?.value === "BC" ? 1 - num("year") : num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    second: num("second"),
  };
}

function wallToUtcMs(w: WallTime): number {
  // setUTCFullYear avoids the Date constructor rule that rewrites years below 100.
  const dt = new Date(0);
  dt.setUTCFullYear(w.year, w.month - 1, w.day);
  dt.setUTCHours(w.hour, w.minute, w.second, 0);
  return dt.getTime();
}

function zoneOffsetMs(timeZone: string, atUtcMs: number): number {
  return wallToUtcMs(wallOf(timeZone, atUtcMs)) - atUtcMs;
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function knownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    // Not a zone name; the caller reports it with the input in the message.
    return false;
  }
}

/**
 * Resolves a local wall clock time in an IANA zone to a UTC epoch ms value (R-T6).
 * A spring forward gap moves the time forward by the gap, a fall back overlap
 * resolves to the earlier (first) instant.
 */
export function zonedTimeToUtcMs(date: string, time: string, timeZone: string): number {
  if (typeof date !== "string") throw new Error(`invalid date "${String(date)}": expected YYYY-MM-DD`);
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (dateMatch === null) throw new Error(`invalid date "${date}": expected YYYY-MM-DD`);
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const dateProbe = new Date(0);
  dateProbe.setUTCFullYear(year, month - 1, day);
  if (dateProbe.getUTCFullYear() !== year || dateProbe.getUTCMonth() !== month - 1 || dateProbe.getUTCDate() !== day) {
    throw new Error(`invalid date "${date}": not a real calendar date`);
  }
  if (typeof time !== "string") throw new Error(`invalid time "${String(time)}": expected HH:MM or HH:MM:SS`);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (timeMatch === null) throw new Error(`invalid time "${time}": expected HH:MM or HH:MM:SS`);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = timeMatch[3] === undefined ? 0 : Number(timeMatch[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`invalid time "${time}": hour, minute or second out of range`);
  }
  if (typeof timeZone !== "string" || !knownTimeZone(timeZone)) {
    throw new Error(`unknown time zone "${String(timeZone)}"`);
  }
  const wall: WallTime = { year, month, day, hour, minute, second };
  const guess = wallToUtcMs(wall);
  // Real zone offsets stay inside +/-14 h and offset periods last at least days, so
  // hourly probes over +/-15 h find every offset this wall time can resolve to.
  const offsets = new Set<number>();
  for (let k = -15; k <= 15; k++) offsets.add(zoneOffsetMs(timeZone, guess + k * HOUR_MS));
  let earliest: number | undefined;
  for (const off of offsets) {
    const t = guess - off;
    if (sameWall(wallOf(timeZone, t), wall) && (earliest === undefined || t < earliest)) {
      // On a fall back overlap two instants match; the earlier one is first.
      earliest = t;
    }
  }
  if (earliest !== undefined) return earliest;
  // No instant has this wall time, so it falls in a spring forward gap. Move forward
  // by the gap: the smallest offset in reach is the one before the jump.
  let pre = Infinity;
  for (const off of offsets) if (off < pre) pre = off;
  return guess - pre;
}
