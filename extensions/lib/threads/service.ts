import { AdaptiveConcurrency } from "./concurrency.ts";
import type { InfinityConfig } from "../config.ts";
import type { Emitter } from "../events.ts";
import type { Logger } from "../log.ts";
import type { SandboxBackend } from "../sandbox/types.ts";
import { InboxWatcher, appendInbox, inboxPath, nextSeq, type InboxLine } from "./inbox.ts";
import { renderReport } from "./reports.ts";
import { NO_TRANSPORT_MESSAGE } from "./transport.ts";
import {
  AGENT_FORK,
  AGENT_FRESH,
  ROOT_ID,
  checkChildOf,
  frameTask,
  newThreadId,
  isThreadId,
  type ThreadFiles,
  type ThreadIdentity,
  type ThreadRecord,
} from "./protocol.ts";

/** What the adapter provides for one call. Kept narrow so tests can fake it. */
export interface DetachedLaunch {
  /** Settles when the child ended. Must not reject, failures are reported as isError. */
  done: Promise<{ output: string; isError: boolean }>;
  abort(): void;
}

export interface ThreadIO {
  /**
   * Which subagent extension carries this call. Absent means interactive, which keeps
   * callers written before the second transport working.
   */
  transport?: "interactive" | "subagents" | "none";
  /** subagents transport. Starts a blocking child without waiting for it. */
  launchDetached?(args: { id: string; task: string; cwd?: string; model?: string }): DetachedLaunch;
  /** Starts a subagent and returns its session file when known. */
  launch(args: { agent: string; task: string; name: string; cwd?: string; model?: string }): Promise<{ sessionFile?: string }>;
  sendToChild(name: string, message: string): Promise<void>;
  /** Present only when a human can answer. */
  confirm?: (title: string, message: string) => Promise<boolean>;
  cwd: string;
  callId?: string;
}

export interface SpawnParams {
  instructions: string;
  child_of: string[];
  fresh_context?: boolean;
  model?: string;
  sandbox?: boolean;
  depends_on?: string[];
}

export interface ThreadServiceDeps {
  identity: ThreadIdentity;
  parentSession?: string;
  /** Contiguous report prefixes persisted on the active parent-session branch. */
  reportedPrefixes?: ReadonlyMap<string, number>;
  files: ThreadFiles;
  /** Tried in order, the first one whose detect() finds a repository wins. */
  sandboxes: SandboxBackend[];
  emitter: Emitter;
  config: InfinityConfig;
  logger: Logger;
  now?: () => number;
  pollMs?: number;
}

interface Child {
  record: ThreadRecord;
  backend?: SandboxBackend;
  /** Worktree/workspace in which this child was created. */
  targetRoot?: string;
  watcher?: InboxWatcher;
  callId?: string;
  abort?: () => void;
  closing?: boolean;
  outcome?: "ok" | "error";
  launchPending?: boolean;
  exitPending?: boolean;
  recovered?: boolean;
}

// Finalizers may outlive a runtime; serialize them across replacement services.
const finalizers = new Map<string, Promise<void>>();

export class ThreadService {
  private readonly children = new Map<string, Child>();
  private disposed = false;
  private readonly d: ThreadServiceDeps;
  private readonly now: () => number;
  private readonly concurrency: AdaptiveConcurrency;
  private launches = 0;
  private launchReservations = 0;
  private launchWindowStart: number | undefined;
  private discovery?: ReturnType<typeof setInterval>;

  constructor(d: ThreadServiceDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.concurrency = new AdaptiveConcurrency(d.config.threads.adaptiveConcurrency);
    if (d.parentSession) {
      this.discover();
      this.discovery = setInterval(() => this.discover(), d.pollMs ?? 1000);
      this.discovery.unref?.();
    }
  }

  private discover(): void {
    if (this.disposed || !this.d.parentSession) return;
    let records: ThreadRecord[];
    try {
      records = this.d.files.list(this.d.logger);
    } catch (err) {
      this.d.logger.error("threads.recover", err);
      return;
    }
    for (const record of records) {
      const stack = this.d.identity.stack;
      if (
        record.parentSession !== this.d.parentSession ||
        record.parentId !== this.d.identity.id ||
        !isThreadId(record.id) ||
        record.id === ROOT_ID ||
        record.transport === "subagents" ||
        record.status !== "running" ||
        typeof record.instructions !== "string" ||
        typeof record.fresh !== "boolean" ||
        !Number.isFinite(record.createdAt) ||
        (record.sessionFile !== undefined && typeof record.sessionFile !== "string") ||
        (record.callId !== undefined && typeof record.callId !== "string") ||
        (record.targetRoot !== undefined && typeof record.targetRoot !== "string") ||
        (record.sandbox &&
          (typeof record.sandbox !== "object" ||
            [record.sandbox.id, record.sandbox.branch, record.sandbox.path, record.sandbox.base, record.sandbox.repoRoot].some(
              (value) => typeof value !== "string",
            ))) ||
        !Array.isArray(record.stack) ||
        record.stack.length !== stack.length + 1 ||
        !stack.every((id, i) => record.stack[i] === id) ||
        record.stack[stack.length] !== record.id
      )
        continue;
      let child = this.children.get(record.id);
      if (!child) {
        const backend = record.sandboxBackend ? this.d.sandboxes.find((b) => b.name === record.sandboxBackend) : undefined;
        if (record.sandbox && !backend) {
          this.d.logger.error("threads.recover", new Error(`Cannot recover sandbox backend for ${record.id}`));
          continue;
        }
        child = { record, backend, targetRoot: record.targetRoot, callId: record.callId, recovered: true };
        this.children.set(record.id, child);
        this.concurrency.restore();
      } else if (!child.record.sessionFile && record.sessionFile && !child.launchPending) {
        child.record.sessionFile = record.sessionFile;
      }
      if (!child.watcher && child.record.sessionFile && !child.closing) this.watchChild(child);
    }
  }

  private watchChild(child: Child): void {
    if (!child.record.sessionFile) return;
    try {
      child.watcher = new InboxWatcher({
        file: inboxPath(child.record.sessionFile),
        logger: this.d.logger,
        pollMs: this.d.pollMs,
        onLine: (line) => this.onInbox(child, line),
      });
      child.watcher.start();
    } catch (err) {
      this.d.logger.error("threads.watch", err);
    }
  }

  get transportSetting(): InfinityConfig["threads"]["transport"] {
    return this.d.config.threads.transport;
  }

  get identity(): ThreadIdentity {
    return this.d.identity;
  }

  list(): ThreadRecord[] {
    return [...this.children.values()].map((c) => c.record);
  }

  runningCount(): number {
    return this.list().filter((r) => r.status === "running").length;
  }

  /** Backend for the repository that contains `cwd`, or null when there is none. */
  async pickBackend(cwd: string): Promise<{ backend: SandboxBackend; repoRoot: string } | null> {
    const wanted = this.d.config.sandbox.backend;
    for (const backend of this.d.sandboxes) {
      if (wanted !== "auto" && backend.name !== wanted) continue;
      const repo = await backend.detect(cwd);
      if (repo) return { backend, repoRoot: repo.repoRoot };
    }
    return null;
  }

  /** R-H1 to R-H4, R-S1. */
  async spawn(p: SpawnParams, io: ThreadIO): Promise<{ id: string; text: string }> {
    if (this.disposed) throw new Error("Cannot spawn a thread after the session has ended.");
    const check = checkChildOf(this.d.identity.stack, p.child_of, this.d.config.threads.maxDepth);
    if (!check.ok) throw new Error(check.message);
    if (p.instructions.trim() === "") throw new Error("instructions must not be empty");
    const dependencies = p.depends_on ?? [];
    if (new Set(dependencies).size !== dependencies.length) throw new Error("depends_on must not contain duplicate thread IDs");
    for (const id of dependencies) {
      const child = this.children.get(id);
      if (!child || child.record.parentId !== this.d.identity.id) throw new Error(`Dependency ${id} is not a known direct child`);
      if (child.record.status !== "closed") throw new Error(`Dependency ${id} is still running or finalizing; wait for its close event`);
      if (child.outcome !== "ok") throw new Error(`Dependency ${id} did not complete successfully`);
    }
    const transport = io.transport ?? "interactive";
    if (transport === "none") throw new Error(NO_TRANSPORT_MESSAGE);
    if (transport === "subagents" && p.fresh_context !== true) {
      throw new Error(
        "This session runs threads on pi-subagents, whose children always start with an empty context and cannot fork yours. " +
          "Call spawn_thread again with fresh_context: true and instructions that contain everything the child needs.",
      );
    }

    this.reserveLaunch();
    let acquired = false;
    let launched = false;
    try {
      this.concurrency.acquire();
      acquired = true;
      return await this.spawnReserved(p, io, transport, () => {
        launched = true;
        this.launchReservations--;
        this.launches++;
      });
    } catch (err) {
      if (!launched) this.launchReservations--;
      if (this.launches === 0 && this.launchReservations === 0) this.launchWindowStart = undefined;
      if (acquired && !launched) this.concurrency.complete("error");
      throw err;
    }
  }

  private reserveLaunch(): void {
    const { maxLaunches, windowSeconds } = this.d.config.threads.launchBudget;
    const now = this.now();
    if (maxLaunches > 0 && this.launches + this.launchReservations >= maxLaunches) {
      throw new Error("Thread launch budget exhausted: maximum launches reached for this session.");
    }
    if (windowSeconds > 0 && this.launchWindowStart !== undefined && now - this.launchWindowStart >= windowSeconds * 1000) {
      throw new Error("Thread launch budget exhausted: admission window has ended for this session.");
    }
    this.launchWindowStart ??= now;
    this.launchReservations++;
  }

  private async spawnReserved(
    p: SpawnParams,
    io: ThreadIO,
    transport: "interactive" | "subagents",
    onLaunched: () => void,
  ): Promise<{ id: string; text: string }> {
    const id = newThreadId();
    const stack = [...this.d.identity.stack, id];
    const fresh = p.fresh_context === true;

    let sandbox: ThreadRecord["sandbox"];
    let backend: SandboxBackend | undefined;
    let targetRoot: string | undefined;
    if (p.sandbox) {
      const where = this.d.identity.record?.sandbox?.path ?? io.cwd;
      const picked = await this.pickBackend(where);
      if (this.disposed) throw new Error("Cannot spawn a thread after the session has ended.");
      if (!picked) throw new Error(`sandbox: true needs a git or jj repository, but ${where} is not inside one`);
      backend = picked.backend;
      targetRoot = picked.repoRoot;
      const parentBranch = this.d.identity.record?.sandbox?.branch;
      sandbox = await backend.create({ cwd: where, id, base: parentBranch, root: this.d.config.sandbox.root });
    }

    // Sandbox creation awaits external commands. Shutdown can happen while they run; do
    // not launch a child after dispose, and leave any newly created sandbox intact.
    if (this.disposed) throw new Error("Cannot spawn a thread after the session has ended.");

    const record: ThreadRecord = {
      id,
      parentId: this.d.identity.id,
      stack,
      instructions: p.instructions,
      fresh,
      createdAt: this.now(),
      status: "running",
      sandbox,
      parentSession: this.d.parentSession,
      targetRoot,
      sandboxBackend: backend?.name,
      callId: io.callId,
      ...(transport === "subagents" ? { transport } : {}),
    };
    let detached: DetachedLaunch | undefined;
    const child: Child = { record, callId: io.callId, backend, targetRoot, launchPending: true };
    let launched = false;
    const markLaunched = () => {
      launched = true;
      onLaunched();
    };
    try {
      const task = frameTask({
        id,
        stack,
        fresh,
        instructions: p.instructions,
        sandbox: sandbox ? { path: sandbox.path, branch: sandbox.branch } : undefined,
        transport,
      });
      if (transport === "subagents") {
        if (!io.launchDetached) throw new Error("bug: the subagents transport needs launchDetached");
        detached = io.launchDetached({ id, task, cwd: sandbox?.path, model: p.model });
        markLaunched();
      } else {
        this.d.files.write(record);
        this.children.set(id, child);
        const result = await io.launch({ agent: fresh ? AGENT_FRESH : AGENT_FORK, task, name: id, cwd: sandbox?.path, model: p.model });
        markLaunched();
        if (result.sessionFile) record.sessionFile = result.sessionFile;
        try {
          this.d.files.write(record);
        } catch (err) {
          this.d.logger.error("threads.spawn", err);
        }
      }
    } catch (err) {
      this.children.delete(id);
      try {
        this.d.files.remove(id);
      } catch (removeErr) {
        this.d.logger.error("threads.spawn", removeErr);
      }
      if (!launched && sandbox && backend) await this.cleanupSandbox(backend, sandbox);
      throw err;
    }

    // A launch can finish after dispose has already traversed the child registry.
    // Do not register it or recreate its file after the session has ended.
    if (this.disposed) {
      if (detached) {
        void detached.done.catch((err: unknown) => this.d.logger.error("threads.shutdown", err));
        detached.abort();
      }
      this.children.delete(id);
      if (detached) this.d.files.remove(id);
      throw new Error("Cannot spawn a thread after the session has ended.");
    }

    child.abort = detached?.abort;
    this.children.set(id, child);
    if (detached) {
      void detached.done.then(
        (res) =>
          this.onClosed(
            child,
            { type: "closed", seq: 0, text: res.output, at: this.now() },
            this.sourceOf(child),
            res.isError ? "error" : "ok",
          ),
        (err: unknown) =>
          this.onClosed(child, { type: "closed", seq: 0, text: String(err), at: this.now() }, this.sourceOf(child), "error"),
      );
    } else if (record.sessionFile) {
      this.watchChild(child);
    } else {
      this.d.logger.error("threads.spawn", new Error(`no session file returned for ${id}, reports from it cannot be received`));
    }
    child.launchPending = false;
    if (child.exitPending) await this.childExited(id);
    const where = sandbox ? ` Its working directory is the sandbox branch ${sandbox.branch}.` : "";
    const arrives =
      transport === "subagents"
        ? "Its final report arrives as one [infinity event] message"
        : "Its reports and its close arrive as [infinity event] messages";
    const text =
      child.closing || record.status === "closed"
        ? `Child thread ${id} (${fresh ? "fresh context" : "inherited context"}) has finished.${where} Its close arrives as an [infinity event] message.`
        : `Child thread ${id} (${fresh ? "fresh context" : "inherited context"}) is running.${where} ` +
          `${arrives}. Do not poll. End your turn or work on something independent.`;
    return { id, text };
  }

  private async cleanupSandbox(backend: SandboxBackend, sb: NonNullable<ThreadRecord["sandbox"]>): Promise<void> {
    try {
      await backend.remove(sb, { keepBranch: false });
    } catch (err) {
      this.d.logger.error("threads.cleanup", err);
    }
  }

  private onInbox(child: Child, line: InboxLine): void {
    const rec = child.record;
    const source = this.sourceOf(child);
    if (line.type === "report") {
      if (child.recovered && line.seq <= (this.d.reportedPrefixes?.get(rec.id) ?? -1)) return;
      this.d.emitter.emit({
        sourceId: rec.id,
        kind: "child_report",
        seq: line.seq,
        source,
        body: `Report from child thread ${rec.id}: ${renderReport(line.text ?? "")}`,
      });
      return;
    }
    void this.onClosed(child, line, source);
  }

  private sourceOf(child: Child): { tool: string; callId?: string; args: unknown } {
    return { tool: "spawn_thread", callId: child.callId, args: { instructions: child.record.instructions.slice(0, 200) } };
  }

  /** True when the thread already closed through close_thread, so its report was delivered. */
  hasClosed(threadId: string): boolean {
    return this.children.get(threadId)?.record.status === "closed";
  }

  /**
   * The subagent process ended. If close_thread was never called, close the thread now so
   * the sandbox is committed and the parent still gets a child_closed event.
   */
  async childExited(threadId: string): Promise<void> {
    const child = this.children.get(threadId);
    if (!child || child.record.status === "closed") return;
    if (child.launchPending) {
      child.exitPending = true;
      return;
    }
    child.watcher?.drain();
    if (this.hasClosed(threadId)) return;
    await this.onClosed(
      child,
      { type: "closed", seq: Number.MAX_SAFE_INTEGER, text: "(the thread ended without calling close_thread)", at: this.now() },
      this.sourceOf(child),
    );
  }

  private async onClosed(
    child: Child,
    line: InboxLine,
    source: { tool: string; callId?: string; args: unknown },
    outcome: "ok" | "error" = "ok",
  ): Promise<void> {
    const rec = child.record;
    if (this.disposed || rec.status === "closed" || child.closing) return;
    const prior = finalizers.get(rec.id);
    if (prior) {
      await prior;
      if (!this.disposed) await this.onClosed(child, line, source, outcome);
      return;
    }
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    finalizers.set(rec.id, lock);
    try {
      child.closing = true;
      child.watcher?.stop();
      const text = renderReport(line.text?.trim() || "(no report)");
      const parts = [
        rec.transport === "subagents"
          ? `Child thread ${rec.id} has finished${outcome === "error" ? " with an error" : ""}. Final report: ${text}`
          : `Child thread ${rec.id} has shut down. Report from child thread: ${text}`,
      ];
      if (rec.sandbox && child.backend) {
        try {
          if (this.d.config.sandbox.autoCommit) await child.backend.commitAll(rec.sandbox, `thread ${rec.id}`);
          const stat = await child.backend.diffStat(rec.sandbox);
          parts.push(
            `Sandbox branch ${rec.sandbox.branch} changes against its base:\n${stat}`,
            `Merge them with squash_sandbox({ thread_id: "${rec.id}" }).`,
          );
        } catch (err) {
          this.d.logger.error("threads.close", err);
          outcome = "error";
          parts.push(`Could not read the sandbox state (${(err as Error).message}). Branch ${rec.sandbox.branch} is intact.`);
        }
      }
      if (this.disposed) return;
      const event = { sourceId: rec.id, kind: "child_closed" as const, seq: 0, source, body: parts.join("\n") };
      this.d.emitter.emit(event);
      if (this.d.emitter.hasPendingOrSeen(event)) {
        try {
          this.d.files.remove(rec.id);
        } catch (err) {
          this.d.logger.error("threads.close", err);
        }
      }
      child.outcome = outcome;
      rec.status = "closed";
      this.concurrency.complete(outcome);
    } finally {
      finalizers.delete(rec.id);
      release();
    }
  }

  /** R-H5, child side. */
  report(text: string): void {
    const file = this.d.identity.inboxFile;
    if (!file) throw new Error("report_to_parent works only inside a thread. You are the root session.");
    appendInbox(file, { type: "report", seq: nextSeq(file), text, at: this.now() });
  }

  /** R-H6, child side. */
  close(report?: string): void {
    const file = this.d.identity.inboxFile;
    if (!file) throw new Error("close_thread works only inside a thread. You are the root session.");
    appendInbox(file, { type: "closed", seq: nextSeq(file), text: report, at: this.now() });
  }

  /** R-H7. */
  async sendToChild(threadId: string, message: string, io: ThreadIO): Promise<void> {
    const child = this.children.get(threadId);
    if (!child || child.record.parentId !== this.d.identity.id) {
      const known =
        this.list()
          .map((r) => r.id)
          .join(", ") || "(none)";
      throw new Error(`${threadId} is not a direct child of ${this.d.identity.id}. Your children: ${known}`);
    }
    if (child.closing || child.record.status === "closed") {
      throw new Error(`Thread ${threadId} is closed and cannot be resumed. Spawn a new thread for further work.`);
    }
    if (child.record.transport === "subagents") {
      throw new Error(
        `Thread ${threadId} runs on pi-subagents, which cannot take messages. Wait for its final report, then spawn a new thread if more work is needed.`,
      );
    }
    await io.sendToChild(threadId, message);
  }

  /** R-S5 to R-S7. */
  async squash(threadId: string, opts: { commit?: boolean }, io: ThreadIO): Promise<string> {
    const child = this.children.get(threadId);
    if (!child || child.record.parentId !== this.d.identity.id) {
      throw new Error(`${threadId} is not a direct child of ${this.d.identity.id}`);
    }
    const sb = child.record.sandbox;
    if (!sb) throw new Error(`thread ${threadId} was not started with sandbox: true`);
    if (child.record.status !== "closed")
      throw new Error(`thread ${threadId} is still running or finalizing; wait for its close event before squashing`);

    const backend = child.backend;
    if (!backend) throw new Error(`bug: thread ${threadId} has a sandbox but no backend`);
    const mine = this.d.identity.record?.sandbox;
    const isRoot = this.d.identity.id === ROOT_ID || !mine;
    let target: string;
    if (mine) {
      target = mine.path;
    } else {
      const repo = await backend.detect(io.cwd);
      if (!repo) throw new Error(`${io.cwd} is not inside a ${backend.name} repository`);
      if (repo.repoRoot !== child.targetRoot) {
        throw new Error(
          `Cannot squash into ${repo.repoRoot}: it is not the worktree or workspace where this sandbox was created (${child.targetRoot}).`,
        );
      }
      target = repo.repoRoot;
      if (!io.confirm)
        throw new Error(
          "Squashing into the main working directory needs the user to confirm, and no UI is available. Ask the user to run it.",
        );
      const ok = await io.confirm("Apply sandbox changes", `Stage the changes of thread ${threadId} (branch ${sb.branch}) in ${target}?`);
      if (!ok) throw new Error("The user declined to apply the sandbox changes.");
    }
    if (this.d.config.sandbox.autoCommit) await backend.commitAll(sb, `thread ${threadId}`);
    const result = await backend.squashInto(target, sb, {
      commit: isRoot ? false : opts.commit !== false,
      message: `squash thread ${threadId}`,
    });
    if (!result.ok) {
      const why = result.conflicts.length > 0 ? `conflicts in: ${result.conflicts.join(", ")}` : (result.error ?? "unknown error");
      throw new Error(
        `Squash of ${threadId} failed (${why}). The sandbox branch ${sb.branch} is intact; inspect the target before retrying.`,
      );
    }
    await backend.remove(sb, { keepBranch: true });
    let how =
      backend.name === "jj"
        ? "left in your working-copy change, review with jj diff"
        : "staged and not committed, review with git diff --cached";
    if (!isRoot && opts.commit !== false) {
      how =
        result.filesChanged === 0 ? "no changes to commit" : `committed${result.commitSha ? ` as ${result.commitSha.slice(0, 8)}` : ""}`;
    }
    return `Squashed ${result.filesChanged} file${result.filesChanged === 1 ? "" : "s"} from ${sb.branch} into ${target}, ${how}. The worktree was removed and the branch kept.`;
  }

  /** R-S7. Lists sandboxes of the repository that contains `cwd`. */
  async listSandboxes(cwd: string): Promise<string> {
    const picked = await this.pickBackend(cwd);
    if (!picked) return "not inside a git or jj repository";
    const infos = await picked.backend.list(picked.repoRoot);
    if (infos.length === 0) return `no sandboxes (${picked.backend.name})`;
    return infos
      .map((i) => `${i.branch}  ${i.merged ? "merged" : "open"}  ${i.hasWorktree ? (i.path ?? "worktree") : "no worktree"}`)
      .join("\n");
  }

  /** R-S7. Deletes merged sandbox branches after confirmation. */
  async pruneSandboxes(io: ThreadIO): Promise<string> {
    const picked = await this.pickBackend(io.cwd);
    if (!picked) return "not inside a git or jj repository";
    if (!io.confirm) return "pruning needs a UI to confirm";
    if (picked.backend.hasPendingWork && (await picked.backend.hasPendingWork(picked.repoRoot))) {
      return "refused: the working tree has applied sandbox changes that are not committed yet. Commit or discard them first.";
    }
    const merged = (await picked.backend.list(picked.repoRoot)).filter((i) => i.merged && !i.hasWorktree);
    if (merged.length === 0) return "nothing to prune";
    const ok = await io.confirm(
      "Prune sandboxes",
      `Prune eligible branches among ${merged.length} merged sandbox branch(es)? Some may be retained if their work cannot be verified.\n${merged.map((m) => m.branch).join("\n")}`,
    );
    if (!ok) return "cancelled";
    const deleted = await picked.backend.pruneMerged(picked.repoRoot);
    if (deleted.length === 0) return "no eligible sandbox branches to prune";
    return `deleted ${deleted.length} sandbox branch(es): ${deleted.join(", ")}`;
  }

  dispose(): void {
    this.disposed = true;
    if (this.discovery) clearInterval(this.discovery);
    for (const c of this.children.values()) {
      c.watcher?.stop();
      if (c.record.status !== "running" || !c.abort) continue;
      // Mark closed first so the settling call does not emit into a session that is ending.
      c.record.status = "closed";
      c.abort();
      try {
        this.d.files.remove(c.record.id);
      } catch (err) {
        this.d.logger.error("threads.dispose", err);
      }
    }
  }

  /** Re-read inboxes once. Tests and shutdown use it to avoid waiting for a poll. */
  drainAll(): void {
    for (const c of this.children.values()) c.watcher?.drain();
  }
}

export { AGENT_FORK, AGENT_FRESH };
