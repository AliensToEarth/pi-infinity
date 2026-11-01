import type { InfinityConfig } from "./config.ts";
import type { Emitter } from "./events.ts";
import type { Logger } from "./log.ts";
import type { SandboxBackend } from "./sandbox.ts";
import { NO_TRANSPORT_MESSAGE } from "./transport.ts";
import {
  AGENT_FORK,
  AGENT_FRESH,
  InboxWatcher,
  ROOT_ID,
  appendInbox,
  checkChildOf,
  frameTask,
  inboxPath,
  newThreadId,
  nextSeq,
  type InboxLine,
  type ThreadFiles,
  type ThreadIdentity,
  type ThreadRecord,
} from "./threads.ts";

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
}

export interface ThreadServiceDeps {
  identity: ThreadIdentity;
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
  watcher?: InboxWatcher;
  callId?: string;
  abort?: () => void;
  closing?: boolean;
}

export class ThreadService {
  private readonly children = new Map<string, Child>();
  private disposed = false;
  private readonly d: ThreadServiceDeps;
  private readonly now: () => number;

  constructor(d: ThreadServiceDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
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
    const check = checkChildOf(this.d.identity.stack, p.child_of, this.d.config.threads.maxDepth);
    if (!check.ok) throw new Error(check.message);
    if (p.instructions.trim() === "") throw new Error("instructions must not be empty");
    const transport = io.transport ?? "interactive";
    if (transport === "none") throw new Error(NO_TRANSPORT_MESSAGE);
    if (transport === "subagents" && p.fresh_context !== true) {
      throw new Error(
        "This session runs threads on pi-subagents, whose children always start with an empty context and cannot fork yours. " +
          "Call spawn_thread again with fresh_context: true and instructions that contain everything the child needs.",
      );
    }

    const id = newThreadId();
    const stack = [...this.d.identity.stack, id];
    const fresh = p.fresh_context === true;

    let sandbox: ThreadRecord["sandbox"];
    let backend: SandboxBackend | undefined;
    if (p.sandbox) {
      const where = this.d.identity.record?.sandbox?.path ?? io.cwd;
      const picked = await this.pickBackend(where);
      if (!picked) throw new Error(`sandbox: true needs a git or jj repository, but ${where} is not inside one`);
      backend = picked.backend;
      const parentBranch = this.d.identity.record?.sandbox?.branch;
      sandbox = await backend.create({ cwd: where, id, base: parentBranch, root: this.d.config.sandbox.root });
    }

    const record: ThreadRecord = {
      id,
      parentId: this.d.identity.id,
      stack,
      instructions: p.instructions,
      fresh,
      createdAt: this.now(),
      status: "running",
      sandbox,
      ...(transport === "subagents" ? { transport } : {}),
    };
    let detached: DetachedLaunch | undefined;
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
      } else {
        this.d.files.write(record);
        const launched = await io.launch({ agent: fresh ? AGENT_FRESH : AGENT_FORK, task, name: id, cwd: sandbox?.path, model: p.model });
        if (launched.sessionFile) record.sessionFile = launched.sessionFile;
        this.d.files.write(record);
      }
    } catch (err) {
      this.d.files.remove(id);
      if (sandbox && backend) await this.cleanupSandbox(backend, sandbox);
      throw err;
    }

    const child: Child = { record, callId: io.callId, backend, abort: detached?.abort };
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
      child.watcher = new InboxWatcher({
        file: inboxPath(record.sessionFile),
        logger: this.d.logger,
        pollMs: this.d.pollMs,
        onLine: (line) => this.onInbox(child, line),
      });
      child.watcher.start();
    } else {
      this.d.logger.error("threads.spawn", new Error(`no session file returned for ${id}, reports from it cannot be received`));
    }
    const where = sandbox ? ` Its working directory is the sandbox branch ${sandbox.branch}.` : "";
    const arrives =
      transport === "subagents"
        ? "Its final report arrives as one [infinity event] message"
        : "Its reports and its close arrive as [infinity event] messages";
    const text =
      `Child thread ${id} (${fresh ? "fresh context" : "inherited context"}) is running.${where} ` +
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
      this.d.emitter.emit({
        sourceId: rec.id,
        kind: "child_report",
        seq: line.seq,
        source,
        body: `Report from child thread ${rec.id}: ${line.text ?? ""}`,
      });
      return;
    }
    if (line.type === "closed") void this.onClosed(child, line, source);
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
    if (rec.status === "closed" || child.closing) return;
    child.closing = true;
    child.watcher?.stop();
    const text = line.text?.trim() || "(no report)";
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
        parts.push(`Could not read the sandbox state (${(err as Error).message}). Branch ${rec.sandbox.branch} is intact.`);
      }
    }
    try {
      this.d.files.remove(rec.id);
    } catch (err) {
      this.d.logger.error("threads.close", err);
    }
    rec.status = "closed";
    if (!this.disposed) this.d.emitter.emit({ sourceId: rec.id, kind: "child_closed", seq: 0, source, body: parts.join("\n") });
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
      throw new Error(`Squash of ${threadId} failed (${why}). The sandbox branch ${sb.branch} is intact and the target is unchanged.`);
    }
    await backend.remove(sb, { keepBranch: true });
    const rootHow =
      backend.name === "jj"
        ? "left in your working-copy change, review with jj diff"
        : "staged and not committed, review with git diff --cached";
    const how = isRoot ? rootHow : `committed${result.commitSha ? ` as ${result.commitSha.slice(0, 8)}` : ""}`;
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
      `Delete ${merged.length} merged sandbox branch(es)?\n${merged.map((m) => m.branch).join("\n")}`,
    );
    if (!ok) return "cancelled";
    const deleted = await picked.backend.pruneMerged(picked.repoRoot);
    return `deleted ${deleted.length} sandbox branch(es): ${deleted.join(", ")}`;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.children.values()) {
      c.watcher?.stop();
      if (c.record.status === "running") {
        if (c.abort) {
          // Mark closed first so the settling call does not emit into a session that is ending.
          c.record.status = "closed";
          c.abort();
        }
        try {
          this.d.files.remove(c.record.id);
        } catch (err) {
          this.d.logger.error("threads.dispose", err);
        }
      }
    }
  }

  /** Re-read inboxes once. Tests and shutdown use it to avoid waiting for a poll. */
  drainAll(): void {
    for (const c of this.children.values()) c.watcher?.drain();
  }
}

export { AGENT_FORK, AGENT_FRESH };
