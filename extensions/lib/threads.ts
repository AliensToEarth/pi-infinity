import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "./log.ts";

export const ROOT_ID = "root";
export const AGENT_FRESH = "thread-fresh";
export const AGENT_FORK = "thread-fork";

export interface ThreadSandbox {
  id: string;
  branch: string;
  path: string;
  base: string;
  repoRoot: string;
}

export interface ThreadRecord {
  id: string;
  /** Absent on records written before the second transport existed, meaning interactive. */
  transport?: "interactive" | "subagents";
  parentId: string;
  /** Ids from root to this thread, inclusive. */
  stack: string[];
  instructions: string;
  fresh: boolean;
  createdAt: number;
  status: "running" | "closed";
  sessionFile?: string;
  sandbox?: ThreadSandbox;
}

export function newThreadId(): string {
  return `t-${randomBytes(16).toString("hex")}`;
}

const THREAD_ID = /^t-(?:[0-9a-f]{6}|[0-9a-f]{32})$/;

export function isThreadId(id: string): boolean {
  return id === ROOT_ID || THREAD_ID.test(id);
}

export type StackCheck = { ok: true } | { ok: false; message: string };

/** R-H1. The caller must name its own real stack in child_of. */
export function checkChildOf(callerStack: string[], childOf: string[], maxDepth: number): StackCheck {
  const same = callerStack.length === childOf.length && callerStack.every((id, i) => id === childOf[i]);
  if (!same) {
    const me = callerStack[callerStack.length - 1];
    return {
      ok: false,
      message:
        `You are thread ${me} with stack [${callerStack.join(", ")}]. ` +
        `The spawn plan you inherited belongs to [${childOf.join(", ")}]. ` +
        "Focus on your own task and do not spawn the parent's threads.",
    };
  }
  if (callerStack.length >= maxDepth) {
    return { ok: false, message: `Thread depth limit reached (${maxDepth}). Do this work yourself or report back to your parent.` };
  }
  return { ok: true };
}

export interface FrameOptions {
  id: string;
  stack: string[];
  fresh: boolean;
  instructions: string;
  sandbox?: { path: string; branch: string };
  /** R-X9. Children of the subagents transport have built-in tools only. */
  transport?: "interactive" | "subagents";
}

/** R-H3, R-X9. Header every child sees first. */
export function frameTask(o: FrameOptions): string {
  if (o.transport === "subagents") return frameBlockingTask(o);
  const parent = o.stack[o.stack.length - 2] ?? ROOT_ID;
  const lines = [
    `You are now INSIDE thread ${o.id}. Your thread stack is [${o.stack.join(", ")}]. Your parent is ${parent}.`,
    o.fresh
      ? "Your context is fresh: you see only this message. The instructions below are self-contained."
      : "You inherited your parent's conversation up to the spawn point. Ignore any plans there to spawn other threads, they belong to your parent.",
    "",
    "Instructions:",
    o.instructions,
    "",
    "How to finish:",
    "- Use report_to_parent for intermediate results that your parent needs before you are done.",
    "- When the work is complete call close_thread with structured: {summary, files?, tests?, blockers?}; optional fields are arrays of strings. Keep it concise. Calling it ends your session.",
    "- If you spawn threads yourself, pass your own stack as child_of.",
  ];
  if (o.sandbox) {
    lines.splice(
      3,
      0,
      `Your working directory is an isolated git worktree at ${o.sandbox.path} on branch ${o.sandbox.branch}. Edit only there. Your changes are committed for you when you close the thread.`,
    );
  }
  return lines.join("\n");
}

function frameBlockingTask(o: FrameOptions): string {
  const parent = o.stack[o.stack.length - 2] ?? ROOT_ID;
  const lines = [
    `You are now INSIDE thread ${o.id}, started by ${parent}. Your context is fresh: you see only this message, so the instructions below are self-contained.`,
    "You have the built-in tools only (read, write, edit, bash, grep, find, ls). You cannot spawn threads or message your parent.",
    "",
    "Instructions:",
    o.instructions,
    "",
    "How to finish:",
    '- Your LAST message is your final report: a JSON object {"summary":"...","files":["..."],"tests":["..."],"blockers":["..."]}. Only summary is required; keep it concise and omit empty arrays.',
    "- There is no close_thread tool. Stopping after your final message ends the thread.",
  ];
  if (o.sandbox) {
    lines.splice(
      2,
      0,
      `Your working directory is an isolated checkout at ${o.sandbox.path} on branch ${o.sandbox.branch}. Edit only there. Your changes are committed for you when you finish.`,
    );
  }
  return lines.join("\n");
}

/** Thread records live where the child process can read them. */
export class ThreadFiles {
  private readonly dir: string;

  constructor(agentDir: string) {
    this.dir = join(agentDir, "infinity", "threads");
  }

  pathFor(id: string): string {
    if (!isThreadId(id)) throw new Error(`bug: invalid thread id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

  write(rec: ThreadRecord): void {
    const file = this.pathFor(rec.id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(rec, null, 2));
  }

  read(id: string): ThreadRecord | null {
    if (!isThreadId(id)) return null;
    const file = this.pathFor(id);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as ThreadRecord;
  }

  remove(id: string): void {
    rmSync(this.pathFor(id), { force: true });
  }
}

export interface ThreadIdentity {
  id: string;
  stack: string[];
  parentId: string | null;
  inboxFile: string | null;
  record: ThreadRecord | null;
}

/** Who am I? Root unless a thread record exists for this subagent name. */
export function identify(env: NodeJS.ProcessEnv, files: ThreadFiles): ThreadIdentity {
  const name = env.PI_SUBAGENT_NAME;
  if (name && isThreadId(name) && name !== ROOT_ID) {
    const record = files.read(name);
    if (record) {
      const session = env.PI_SUBAGENT_SESSION;
      return { id: record.id, stack: record.stack, parentId: record.parentId, inboxFile: session ? inboxPath(session) : null, record };
    }
  }
  return { id: ROOT_ID, stack: [ROOT_ID], parentId: null, inboxFile: null, record: null };
}

export function inboxPath(sessionFile: string): string {
  return `${sessionFile}.reports.jsonl`;
}

export interface InboxLine {
  type: "report" | "closed";
  seq: number;
  text?: string;
  at: number;
}

function isInboxLine(value: unknown): value is InboxLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  return (
    (line.type === "report" || line.type === "closed") &&
    typeof line.seq === "number" &&
    Number.isSafeInteger(line.seq) &&
    line.seq >= 0 &&
    typeof line.at === "number" &&
    Number.isFinite(line.at) &&
    (line.text === undefined || typeof line.text === "string")
  );
}

export function appendInbox(file: string, line: InboxLine): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

export function nextSeq(file: string): number {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8");
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

export interface InboxWatcherOptions {
  file: string;
  onLine: (line: InboxLine) => void;
  logger: Logger;
  pollMs?: number;
}

/**
 * R-H5. Tails a JSONL file. Uses fs.watch for latency and a poll as the fallback
 * because fs.watch drops events on some filesystems. Partial last lines wait for
 * their newline.
 */
export class InboxWatcher {
  private offset = 0;
  private carry = "";
  private readonly decoder = new StringDecoder("utf8");
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private readonly o: InboxWatcherOptions;

  constructor(o: InboxWatcherOptions) {
    this.o = o;
  }

  start(): void {
    this.timer = setInterval(() => this.drain(), this.o.pollMs ?? 1000);
    // Never keep the process alive just to tail a file.
    this.timer.unref();
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      this.watcher = watch(dirname(this.o.file), () => this.drain());
      this.watcher.unref();
      this.watcher.on("error", (err) => this.o.logger.error("threads.watch", err));
    } catch (err) {
      this.o.logger.error("threads.watch", err);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = undefined;
    this.watcher = undefined;
  }

  drain(): void {
    let size: number;
    try {
      size = statSync(this.o.file).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.o.logger.error("threads.inbox", err);
      return;
    }
    if (size <= this.offset) return;
    const len = size - this.offset;
    const buf = Buffer.alloc(len);
    let bytesRead: number;
    try {
      const fd = openSync(this.o.file, "r");
      try {
        bytesRead = readSync(fd, buf, 0, len, this.offset);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.o.logger.error("threads.inbox", err);
      return;
    }
    this.offset += bytesRead;
    const text = this.carry + this.decoder.write(buf.subarray(0, bytesRead));
    const parts = text.split("\n");
    this.carry = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(part) as unknown;
      } catch (err) {
        this.o.logger.error("threads.inbox", new Error(`bad inbox line ${JSON.stringify(part.slice(0, 80))}: ${(err as Error).message}`));
        continue;
      }
      if (!isInboxLine(parsed)) {
        this.o.logger.error("threads.inbox", new Error(`bad inbox line ${JSON.stringify(part.slice(0, 80))}: malformed record`));
        continue;
      }
      this.o.onLine(parsed);
    }
  }
}
