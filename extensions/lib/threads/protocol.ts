import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../log.ts";
import { inboxPath } from "./inbox.ts";

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
  /** Exact parent session file; legacy and transient-session records cannot be recovered safely. */
  parentSession?: string;
  targetRoot?: string;
  sandboxBackend?: string;
  callId?: string;
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
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(rec, null, 2), { flag: "wx" });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  read(id: string): ThreadRecord | null {
    if (!isThreadId(id)) return null;
    const file = this.pathFor(id);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as ThreadRecord;
  }

  list(logger: Logger): ThreadRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: ThreadRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!isThreadId(id) || id === ROOT_ID) continue;
      try {
        const rec = this.read(id);
        if (rec && typeof rec === "object" && rec.id === id) records.push(rec);
        else if (rec) logger.error("threads.recover", new Error(`invalid thread record ${name}`));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") logger.error("threads.recover", err);
      }
    }
    return records;
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
