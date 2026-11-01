import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InfinityConfig } from "./config.ts";
import type { EventInput } from "./events.ts";
import type { Logger } from "./log.ts";
import { isolatedCommand } from "./process-isolation.ts";

export type JobStatus = "running" | "exited" | "signaled" | "cancelled" | "timeout" | "error";

export interface Job {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid?: number;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  logPath: string;
  lines: number;
  bytes: number;
  associative: boolean;
  watch: string[];
  matches: number;
  suppressed: number;
  callId?: string;
  errorMessage?: string;
}

export interface StartOptions {
  command: string;
  name?: string;
  cwd: string;
  watch?: string[];
  associative?: boolean;
  timeoutSeconds?: number;
  isolate?: boolean;
  callId?: string;
}

export interface JobDeps {
  emit: (event: EventInput) => void;
  logDir: string;
  config: InfinityConfig["jobs"];
  logger: Logger;
  now?: () => number;
  /** Replaceable for tests. Must return a child with piped stdout and stderr. */
  spawn?: (command: string, cwd: string) => ChildProcess;
  /** Replaceable for tests. Sends a signal to the whole process group. */
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  killGraceMs?: number;
  /** Time to wait for stdio to close after the process exits. */
  closeGraceMs?: number;
}

const RING_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_PATTERN_CHARS = 200;
const MAX_MATCH_LINE_CHARS = 500;
const MAX_MATCH_BODY_CHARS = 3000;

interface Internal {
  job: Job;
  child?: ChildProcess;
  ring: string;
  partial: { stdout: string; stderr: string };
  patterns: RegExp[];
  pending: string[];
  flushTimer?: ReturnType<typeof setTimeout>;
  matchSeq: number;
  emitTimes: number[];
  firstMatch?: string;
  lastMatch?: string;
  cancelRequested: boolean;
  timedOut: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setTimeout>;
  finalized: boolean;
  logTruncated: boolean;
  exitSeen: boolean;
}

export function defaultKillGroup(pid: number, signal: NodeJS.Signals): void {
  // A negative pid addresses the process group created by detached spawn.
  process.kill(-pid, signal);
}

function defaultSpawn(command: string, cwd: string): ChildProcess {
  return nodeSpawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
}

export function compileWatch(patterns: string[]): RegExp[] {
  return patterns.map((source) => {
    if (source.length === 0) throw new Error("watch pattern must not be empty");
    if (source.length > MAX_PATTERN_CHARS)
      throw new Error(`watch pattern longer than ${MAX_PATTERN_CHARS} characters: ${source.slice(0, 40)}...`);
    try {
      return new RegExp(source);
    } catch (err) {
      throw new Error(`invalid watch pattern ${JSON.stringify(source)}: ${(err as Error).message}`);
    }
  });
}

function lastLines(text: string, count: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count).join("\n");
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export class JobManager {
  private readonly jobs = new Map<string, Internal>();
  private counter = 0;
  private readonly deps: JobDeps;
  private readonly now: () => number;

  constructor(deps: JobDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** R-J1, R-J2, R-J5, R-J10. Returns before the process produces output. */
  start(opts: StartOptions): Job {
    const running = this.list().filter((j) => j.status === "running");
    if (running.length >= this.deps.config.max) {
      const names = running.map((j) => `${j.id} (${j.name})`).join(", ");
      throw new Error(
        `too many background jobs running (${running.length} of ${this.deps.config.max}): ${names}. Cancel one with bg_cancel or wait for an exit event.`,
      );
    }
    if (opts.command.trim() === "") throw new Error("command must not be empty");
    const patterns = compileWatch(opts.watch ?? []);
    const isolated = opts.isolate ? isolatedCommand(opts.command, opts.cwd) : undefined;
    mkdirSync(this.deps.logDir, { recursive: true });
    let id: string;
    let logPath: string;
    for (;;) {
      id = `j${++this.counter}`;
      logPath = join(this.deps.logDir, `${id}.log`);
      try {
        const fd = openSync(logPath, "wx");
        closeSync(fd);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    const job: Job = {
      id,
      name: opts.name?.trim() || opts.command.trim().split(/\s+/)[0] || id,
      command: opts.command,
      cwd: opts.cwd,
      status: "running",
      startedAt: this.now(),
      logPath,
      lines: 0,
      bytes: 0,
      associative: opts.associative === true,
      watch: opts.watch ?? [],
      matches: 0,
      suppressed: 0,
      callId: opts.callId,
    };
    const st: Internal = {
      job,
      ring: "",
      partial: { stdout: "", stderr: "" },
      patterns,
      pending: [],
      matchSeq: 0,
      emitTimes: [],
      cancelRequested: false,
      timedOut: false,
      finalized: false,
      logTruncated: false,
      exitSeen: false,
    };
    this.jobs.set(id, st);
    let child: ChildProcess;
    try {
      child = isolated
        ? nodeSpawn(isolated.executable, isolated.args, {
            cwd: opts.cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
          })
        : (this.deps.spawn ?? defaultSpawn)(opts.command, opts.cwd);
    } catch (err) {
      this.fail(st, err);
      return job;
    }
    st.child = child;
    job.pid = child.pid;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(st, "stdout", chunk));
    child.stderr?.on("data", (chunk: string) => this.onData(st, "stderr", chunk));
    child.on("error", (err) => this.fail(st, err));
    child.on("exit", (code, signal) => this.onExit(st, code, signal));
    child.on("close", () => this.finalize(st));
    if (opts.timeoutSeconds && opts.timeoutSeconds > 0) {
      st.timeoutTimer = setTimeout(() => {
        st.timedOut = true;
        this.requestKill(st);
      }, opts.timeoutSeconds * 1000);
    }
    return job;
  }

  list(): Job[] {
    return [...this.jobs.values()].map((s) => s.job);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  runningCount(): number {
    return this.list().filter((j) => j.status === "running").length;
  }

  /** R-J8. Never waits. Idempotent. */
  cancel(id: string): { job: Job; alreadyFinished: boolean } {
    const st = this.jobs.get(id);
    if (!st)
      throw new Error(
        `unknown job id ${JSON.stringify(id)}. Known jobs: ${
          this.list()
            .map((j) => j.id)
            .join(", ") || "(none)"
        }`,
      );
    if (st.job.status !== "running" || st.exitSeen) return { job: st.job, alreadyFinished: true };
    st.cancelRequested = true;
    this.requestKill(st);
    return { job: st.job, alreadyFinished: false };
  }

  /** R-J9. Best effort, used at session shutdown. */
  cancelAll(): number {
    let count = 0;
    for (const st of this.jobs.values()) {
      if (st.job.status !== "running" || st.exitSeen) continue;
      st.cancelRequested = true;
      this.requestKill(st);
      count++;
    }
    return count;
  }

  /** Release timers except a pending kill escalation. Used when the runtime is discarded. */
  dispose(): void {
    for (const st of this.jobs.values()) {
      for (const t of [st.flushTimer, st.timeoutTimer, st.closeTimer]) if (t) clearTimeout(t);
    }
  }

  /** R-J3. Tail from the ring buffer, or a byte range from the log file. */
  output(id: string, opts: { tail?: number; since?: number; maxBytes?: number }): { text: string; nextOffset: number; status: JobStatus } {
    const st = this.jobs.get(id);
    if (!st) throw new Error(`unknown job id ${JSON.stringify(id)}`);
    if (opts.since !== undefined && (!Number.isSafeInteger(opts.since) || opts.since < 0)) {
      throw new Error("since must be a non-negative safe integer byte offset");
    }
    if (opts.tail !== undefined && (!Number.isSafeInteger(opts.tail) || opts.tail < 1)) {
      throw new Error("tail must be a positive safe integer");
    }
    const max = opts.maxBytes ?? 8000;
    if (!Number.isSafeInteger(max) || max < 4) throw new Error("maxBytes must be a safe integer of at least 4");
    if (opts.since === undefined) {
      const text = lastLines(st.ring, opts.tail ?? this.deps.config.tailLines);
      const bytes = Buffer.from(text);
      let start = Math.max(0, bytes.length - max);
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      return { text: bytes.toString("utf8", start), nextOffset: st.job.bytes, status: st.job.status };
    }
    const size = statSync(st.job.logPath).size;
    const from = Math.min(Math.max(0, opts.since), size);
    const len = Math.min(max, size - from);
    const buf = Buffer.alloc(len);
    const fd = openSync(st.job.logPath, "r");
    let bytesRead: number;
    try {
      bytesRead = readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    // A caller may supply an arbitrary byte offset inside a multibyte character.
    let start = 0;
    while (start < bytesRead && (buf[start] & 0xc0) === 0x80) start++;
    let end = bytesRead;
    if (end > start) {
      let lead = end - 1;
      while (lead > start && (buf[lead] & 0xc0) === 0x80) lead--;
      const byte = buf[lead];
      const width = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
      if (end - lead < width) end = lead;
    }
    return { text: buf.toString("utf8", start, end), nextOffset: from + end, status: st.job.status };
  }

  private requestKill(st: Internal): void {
    const pid = st.job.pid;
    if (pid === undefined || st.job.status !== "running") return;
    this.signal(pid, "SIGTERM");
    if (!st.killTimer) {
      st.killTimer = setTimeout(() => {
        // The shell may have exited while descendants in its group ignored SIGTERM.
        this.signal(pid, "SIGKILL");
      }, this.deps.killGraceMs ?? 3000);
    }
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      (this.deps.killGroup ?? defaultKillGroup)(pid, signal);
    } catch (err) {
      // ESRCH means the group is already gone, which is the outcome we wanted.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") this.deps.logger.error("jobs.kill", err);
    }
  }

  private onData(st: Internal, stream: "stdout" | "stderr", chunk: string): void {
    if (st.finalized) return;
    st.job.bytes += Buffer.byteLength(chunk);
    if (st.job.bytes <= MAX_LOG_BYTES) {
      try {
        appendFileSync(st.job.logPath, chunk);
      } catch (err) {
        this.deps.logger.error("jobs.log", err);
      }
    } else if (!st.logTruncated) {
      st.logTruncated = true;
    }
    st.ring += chunk;
    if (st.ring.length > RING_BYTES) st.ring = st.ring.slice(st.ring.length - RING_BYTES);
    const parts = chunk.split("\n");
    if (parts.length === 1) {
      st.partial[stream] = (st.partial[stream] + chunk).slice(0, RING_BYTES);
      return;
    }
    this.onLine(st, (st.partial[stream] + parts[0]).slice(0, RING_BYTES));
    for (let i = 1; i < parts.length - 1; i++) this.onLine(st, parts[i].slice(0, RING_BYTES));
    st.partial[stream] = (parts[parts.length - 1] ?? "").slice(0, RING_BYTES);
  }

  private onLine(st: Internal, line: string): void {
    st.job.lines++;
    if (st.patterns.length === 0) return;
    if (!st.patterns.some((p) => p.test(line))) return;
    st.job.matches++;
    const clipped = line.length > MAX_MATCH_LINE_CHARS ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}...` : line;
    st.firstMatch ??= clipped;
    st.lastMatch = clipped;
    st.pending.push(clipped);
    if (st.pending.length >= this.deps.config.watchBatchLines) {
      this.flushMatches(st);
    } else {
      if (st.flushTimer) clearTimeout(st.flushTimer);
      st.flushTimer = setTimeout(() => this.flushMatches(st), this.deps.config.watchDebounceMs);
    }
  }

  /** R-J6. Rate limited unless the job is associative. */
  private flushMatches(st: Internal): void {
    if (st.flushTimer) clearTimeout(st.flushTimer);
    st.flushTimer = undefined;
    if (st.pending.length === 0) return;
    const lines = st.pending;
    st.pending = [];
    const t = this.now();
    if (!st.job.associative) {
      st.emitTimes = st.emitTimes.filter((x) => t - x < 60_000);
      if (st.emitTimes.length >= this.deps.config.watchEventsPerMin) {
        st.job.suppressed += lines.length;
        return;
      }
      st.emitTimes.push(t);
    }
    let body = lines.join("\n");
    if (body.length > MAX_MATCH_BODY_CHARS) body = `${body.slice(0, MAX_MATCH_BODY_CHARS)}\n...`;
    this.deps.emit({
      sourceId: st.job.id,
      kind: "job_match",
      seq: st.matchSeq++,
      source: { tool: "bg_run", callId: st.job.callId, args: { command: st.job.command, watch: st.job.watch } },
      body: `job ${st.job.id} "${st.job.name}" printed ${lines.length} matching line${lines.length === 1 ? "" : "s"}:\n${body}`,
    });
  }

  private onExit(st: Internal, code: number | null, signal: NodeJS.Signals | null): void {
    st.exitSeen = true;
    if (st.timeoutTimer) clearTimeout(st.timeoutTimer);
    st.timeoutTimer = undefined;
    st.job.exitCode = code;
    st.job.signal = signal;
    // Grandchildren may keep stdio open. Do not wait for them forever.
    st.closeTimer = setTimeout(() => this.finalize(st), this.deps.closeGraceMs ?? 1000);
  }

  private fail(st: Internal, err: unknown): void {
    if (st.finalized) return;
    st.job.errorMessage = (err as Error).message ?? String(err);
    this.deps.logger.error("jobs.spawn", err);
    st.job.status = "error";
    this.finalize(st);
  }

  private finalize(st: Internal): void {
    if (st.finalized) return;
    st.finalized = true;
    // A pending group kill must outlive the shell's exit and this job's finalization.
    for (const t of [st.timeoutTimer, st.closeTimer]) if (t) clearTimeout(t);
    for (const stream of ["stdout", "stderr"] as const) {
      if (st.partial[stream] !== "") {
        const rest = st.partial[stream];
        st.partial[stream] = "";
        this.onLine(st, rest);
      }
    }
    this.flushMatches(st);
    const job = st.job;
    job.endedAt = this.now();
    if (job.status === "running") {
      if (st.timedOut) job.status = "timeout";
      else if (st.cancelRequested) job.status = "cancelled";
      else if (job.signal) job.status = "signaled";
      else job.status = "exited";
    }
    this.deps.emit({
      sourceId: job.id,
      kind: "job_exit",
      seq: 0,
      source: { tool: "bg_run", callId: job.callId, args: { command: job.command } },
      body: this.exitBody(st),
    });
  }

  private exitBody(st: Internal): string {
    const job = st.job;
    const took = formatDuration((job.endedAt ?? this.now()) - job.startedAt);
    const how =
      job.status === "exited"
        ? `exit code ${job.exitCode}`
        : job.status === "signaled"
          ? `killed by ${job.signal}`
          : job.status === "error"
            ? `failed to start: ${job.errorMessage}`
            : job.status === "timeout"
              ? "stopped after its timeout"
              : "cancelled";
    const out = [
      `job ${job.id} "${job.name}" finished: ${job.status} (${how}, ${took})`,
      `command: ${job.command}`,
      `log: ${job.logPath} (${job.lines} lines, ${job.bytes} bytes${st.logTruncated ? ", log file capped" : ""})`,
    ];
    if (job.watch.length > 0) {
      out.push(`matches: ${job.matches} total, ${job.suppressed} not delivered because of the rate limit`);
      if (st.firstMatch !== undefined) out.push(`first match: ${st.firstMatch}`, `last match: ${st.lastMatch}`);
    }
    const tail = lastLines(st.ring, this.deps.config.tailLines);
    out.push(`--- last ${Math.min(this.deps.config.tailLines, job.lines || 1)} lines ---`, tail === "" ? "(no output)" : tail);
    return out.join("\n");
  }
}
