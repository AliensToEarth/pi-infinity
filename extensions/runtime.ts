import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type InfinityConfig } from "./lib/config.ts";
import { Emitter } from "./lib/events.ts";
import { JobManager } from "./lib/jobs.ts";
import { createLogger, type Logger } from "./lib/log.ts";
import { GitSandbox } from "./lib/sandbox.ts";
import { JjSandbox } from "./lib/sandbox-jj.ts";
import { ThreadService } from "./lib/thread-service.ts";
import { ThreadFiles, identify } from "./lib/threads.ts";
import { TimerStore, type TimerEntry } from "./lib/timers.ts";

export interface Runtime {
  cwd: string;
  config: InfinityConfig;
  logger: Logger;
  emitter: Emitter;
  jobs: JobManager;
  timers: TimerStore;
  threads?: ThreadService;
  artifactDir: string;
  spillDir: string;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  dispose(): void;
}

export function artifactDirFor(ctx: ExtensionContext): string {
  const file = ctx.sessionManager.getSessionFile();
  if (file) {
    return join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId(), "infinity");
  }
  return join(tmpdir(), "pi-infinity", String(process.pid));
}

function isTimerEntry(data: unknown): data is TimerEntry {
  if (typeof data !== "object" || data === null) return false;
  const op = (data as { op?: unknown }).op;
  return op === "set" || op === "fired" || op === "cancelled";
}

/** Timer records stored in the active branch, oldest first. */
export function timerEntriesFromBranch(branch: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): TimerEntry[] {
  const out: TimerEntry[] = [];
  for (const e of branch) {
    if (e.type === "custom" && e.customType === "infinity-timer" && isTimerEntry(e.data)) out.push(e.data);
  }
  return out;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function createRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Runtime {
  const artifactDir = artifactDirFor(ctx);
  mkdirSync(artifactDir, { recursive: true });
  const logger = createLogger(join(artifactDir, "infinity.log"));
  const loaded = loadConfig(ctx.cwd, logger);
  const config = loaded.config;
  const notify: Runtime["notify"] = (message, level = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else logger.debug("notify", message);
  };
  if (loaded.problems.length > 0) notify(`pi-infinity config problems: ${loaded.problems.join("; ")}`, "warning");

  const spillDir = join(artifactDir, "spill");
  const emitter = new Emitter({
    send: (message, options) => pi.sendMessage(message, options),
    spillDir,
    maxChars: config.events.maxChars,
    seenCap: config.events.seenCap,
    logger,
    notify: (m) => notify(m, "warning"),
    persist: (input) => pi.appendEntry("infinity-event-pending", input),
  });
  emitter.restore(ctx.sessionManager.getBranch() as never);
  const jobs = new JobManager({
    emit: (e) => void emitter.emit(e),
    logDir: join(artifactDir, "jobs"),
    config: config.jobs,
    logger,
  });
  const timers = new TimerStore({
    now: Date.now,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    persist: (entry) => pi.appendEntry("infinity-timer", entry),
    fire: (timer, lateMs) => {
      const late = lateMs > 1000 ? ` (late by ${Math.round(lateMs / 1000)}s, the session was not running)` : "";
      emitter.emit({
        sourceId: timer.id,
        kind: "timer",
        seq: 0,
        source: { tool: timer.kind, args: { note: timer.note } },
        body: `timer ${timer.id} fired${late}.${timer.note ? ` note: ${timer.note}` : ""}`,
      });
    },
    newId: () => `timer-${randomBytes(3).toString("hex")}`,
    max: config.timers.max,
    logger,
  });
  const restored = timers.restore(timerEntriesFromBranch(ctx.sessionManager.getBranch() as never));
  if (restored.rearmed + restored.firedLate > 0)
    logger.debug("timers", `restored ${restored.rearmed} timers, ${restored.firedLate} fired late`);

  let threads: ThreadService | undefined;
  if (config.threads.enabled) {
    const files = new ThreadFiles(agentDir());
    threads = new ThreadService({
      identity: identify(process.env, files),
      files,
      sandboxes: [new JjSandbox(logger), new GitSandbox(logger)],
      emitter,
      config,
      logger,
    });
  }

  return {
    cwd: ctx.cwd,
    config,
    logger,
    emitter,
    jobs,
    timers,
    threads,
    artifactDir,
    spillDir,
    notify,
    dispose: () => {
      const n = jobs.cancelAll();
      if (n > 0) logger.debug("jobs", `cancelled ${n} running jobs at shutdown`);
      jobs.dispose();
      timers.dispose();
      threads?.dispose();
    },
  };
}
