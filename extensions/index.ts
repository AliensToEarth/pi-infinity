import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { blockMessage, classifyBash } from "./lib/blocking.ts";
import { guardContent, type Part } from "./lib/overflow.ts";
import { ThreadFiles, identify } from "./lib/threads.ts";
import { registerEventRenderer } from "./render.ts";
import { agentDir, createRuntime, type Runtime } from "./runtime.ts";
import { registerWithSubagents } from "./subagents-bridge.ts";
import { childTools, spawnerTools } from "./tools/threads.ts";
import { jobTools } from "./tools/jobs.ts";
import { timerTools } from "./tools/timers.ts";
import type { ToolDef } from "./tools/types.ts";

export default function piInfinity(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const rt = (): Runtime => {
    if (!runtime) throw new Error("pi-infinity is not started yet (no session)");
    return runtime;
  };

  const threadSvc = () => {
    const svc = rt().threads;
    if (!svc) throw new Error("threads are disabled (threads.enabled is false in infinity.json)");
    return svc;
  };
  const inThread = identify(process.env, new ThreadFiles(agentDir())).id !== "root";
  const tools: ToolDef[] = [...jobTools(rt), ...timerTools(rt), ...spawnerTools(threadSvc), ...(inThread ? childTools(threadSvc) : [])];
  for (const tool of tools) pi.registerTool(tool);
  registerEventRenderer(pi);

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!runtime || !ctx.hasUI) return;
    const parts: string[] = [];
    const jobs = runtime.jobs.runningCount();
    const timers = runtime.timers.list().length;
    if (jobs > 0) parts.push(`jobs ${jobs}`);
    if (timers > 0) parts.push(`timers ${timers}`);
    ctx.ui.setStatus("infinity", parts.length > 0 ? parts.join(", ") : undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    runtime?.dispose();
    runtime = createRuntime(pi, ctx);
    if (runtime.config.threads.enabled)
      registerWithSubagents(
        tools.map((t) => t.name),
        runtime.logger,
        (m) => runtime?.notify(m, "warning"),
        pi.getAllTools().map((t) => t.name),
        runtime.config.threads.transport,
      );
    if (statusTimer) clearInterval(statusTimer);
    if (ctx.hasUI) statusTimer = setInterval(() => updateStatus(ctx), 1000);
  });

  // R-J9, R-H8. Best effort and idempotent.
  pi.on("session_shutdown", (_event, ctx) => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
    runtime?.dispose();
    runtime = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("infinity", undefined);
  });

  // R-B1 to R-B5.
  pi.on("tool_call", (event) => {
    if (!runtime || event.toolName !== "bash") return;
    const input = event.input as { command?: unknown; timeout?: number };
    if (typeof input.command !== "string") return;
    const cfg = runtime.config.bash;
    if (cfg.guard !== "off") {
      const verdict = classifyBash(input.command, cfg.sleepLimitSec);
      if (verdict.blocked) {
        if (cfg.guard === "block") return { block: true, reason: blockMessage(verdict, input.command, "block") };
        runtime.notify(blockMessage(verdict, input.command, "warn"), "warning");
      }
    }
    if (input.timeout === undefined && cfg.defaultTimeoutSec > 0) input.timeout = cfg.defaultTimeoutSec;
  });

  // R-O1 to R-O3.
  pi.on("tool_result", (event) => {
    if (!runtime || event.toolName === "read" || event.structuredContent !== undefined) return;
    const rt0 = runtime;
    const replaced = guardContent(event.content as Part[], rt0.spillDir, rt0.config.overflow, (err) => rt0.logger.error("overflow", err));
    if (replaced) return { content: replaced as never };
  });

  // B-4, B-5. The subagents extension sends its own exit message for every child. Close the
  // thread if close_thread never ran, and shrink the message when the report was already
  // delivered so the parent is not shown the same text twice.
  pi.on("message_end", (event) => {
    const m = event.message as { role?: string; customType?: string; details?: { name?: unknown } };
    if (m.role !== "custom" || m.customType !== "subagent_result" || !runtime?.threads) return;
    const name = m.details?.name;
    if (typeof name !== "string") return;
    const svc = runtime.threads;
    if (svc.hasClosed(name)) {
      return {
        message: { ...event.message, content: `Thread ${name} exited. Its report was already delivered as an [infinity event].` } as never,
      };
    }
    void svc.childExited(name).catch((err) => runtime?.logger.error("threads.exit", err));
  });

  pi.registerCommand("infinity", {
    description: "pi-infinity status: jobs, timers, threads, sandboxes, prune, cancel <id|all>, config",
    handler: async (args, ctx) => {
      const r = rt();
      const [sub = "status", arg] = args.trim().split(/\s+/);
      const lines: string[] = [];
      if (sub === "status" || sub === "jobs") {
        const jobs = r.jobs.list();
        lines.push(jobs.length === 0 ? "no jobs" : jobs.map((j) => `${j.id} ${j.status} "${j.name}" ${j.logPath}`).join("\n"));
      }
      if (sub === "status" || sub === "timers") {
        const timers = r.timers.list();
        lines.push(
          timers.length === 0
            ? "no timers"
            : timers.map((t) => `${t.id} due ${new Date(t.dueAt).toISOString()} ${t.note ?? ""}`).join("\n"),
        );
      }
      if (sub === "cancel") {
        if (arg === "all") lines.push(`cancelled ${r.jobs.cancelAll()} jobs, ${r.timers.cancelAll()} timers`);
        else if (arg?.startsWith("timer-")) lines.push(r.timers.cancel(arg) ? `cancelled ${arg}` : `${arg} is not pending`);
        else if (arg) lines.push(`cancel requested for ${r.jobs.cancel(arg).job.id}`);
        else lines.push("usage: /infinity cancel <id|all>");
      }
      if (sub === "threads" || sub === "status") {
        const threads = r.threads?.list() ?? [];
        if (sub === "threads" || threads.length > 0)
          lines.push(
            threads.length === 0
              ? "no threads"
              : threads
                  .map(
                    (t) => `${t.id} ${t.status} ${t.transport ?? "interactive"} ${t.fresh ? "fresh" : "fork"} ${t.sandbox?.branch ?? ""}`,
                  )
                  .join("\n"),
          );
      }
      if (sub === "sandboxes" && r.threads) lines.push(await r.threads.listSandboxes(ctx.cwd));
      if (sub === "prune" && r.threads) {
        lines.push(
          await r.threads.pruneSandboxes({
            cwd: ctx.cwd,
            confirm: ctx.hasUI ? (t: string, m: string) => ctx.ui.confirm(t, m) : undefined,
          } as never),
        );
      }
      if (sub === "config") lines.push(JSON.stringify(r.config, null, 2));
      if (lines.length === 0) lines.push("usage: /infinity [status|jobs|timers|threads|sandboxes|prune|cancel <id|all>|config]");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
