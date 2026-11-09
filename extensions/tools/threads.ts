import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { loadBlockingPrompt, launchViaSubagents } from "../lib/subagents-launch.ts";
import { encodeReport } from "../lib/thread-reports.ts";
import { scopedModel } from "../lib/scoped-model.ts";
import type { ThreadIO, ThreadService } from "../lib/thread-service.ts";
import { pickTransport, readAgentRegistry, type TransportSetting } from "../lib/transport.ts";
import { tool, type ToolDef } from "./types.ts";

type ExecuteTool = (
  name: string,
  args: unknown,
) => Promise<{ isError: boolean; result: { content: Array<{ type: string; text?: string }>; details?: unknown } }>;

interface ToolCtx {
  cwd: string;
  hasUI: boolean;
  ui: { confirm(title: string, message: string): Promise<boolean> };
  executeTool: ExecuteTool;
  tools?: ReadonlyArray<{ name: string }>;
  model?: { provider: string; id: string };
  scopedModels?: ReadonlyArray<{ model: { provider: string; id: string } }>;
}

const BLOCKING_PROMPT_FILE = fileURLToPath(new URL("../../agents/blocking/thread-blocking.md", import.meta.url));

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("\n")
    .trim();
}

export function interactiveAgentName(agent: string, caller?: string): string {
  return agent === caller ? `${agent}-nested` : agent;
}

function ioFor(ctx: ToolCtx, setting: TransportSetting, callId?: string): ThreadIO {
  const run = async (name: string, args: unknown) => {
    const outcome = await ctx.executeTool(name, args);
    const details = outcome.result.details as { error?: unknown } | undefined;
    if (outcome.isError || (typeof details?.error === "string" && details.error)) {
      throw new Error(`${name} failed: ${typeof details?.error === "string" && details.error ? details.error : textOf(outcome.result)}`);
    }
    return outcome.result;
  };
  const registry = readAgentRegistry();
  const transport = pickTransport(
    setting,
    (ctx.tools ?? []).map((t) => t.name),
    registry !== undefined,
  );
  const sessionModel = ctx.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  return {
    transport,
    launchDetached: (a) => {
      if (!registry) throw new Error("bug: pi-subagents registry missing for the subagents transport");
      return launchViaSubagents({
        registry,
        executeTool: ctx.executeTool,
        id: a.id,
        task: a.task,
        cwd: a.cwd,
        model: a.model,
        sessionModel,
        systemPrompt: loadBlockingPrompt(BLOCKING_PROMPT_FILE),
        promptFile: BLOCKING_PROMPT_FILE,
      });
    },
    cwd: ctx.cwd,
    callId,
    launch: async (a) => {
      const result = await run("subagent", {
        agent: interactiveAgentName(a.agent, process.env.PI_SUBAGENT_AGENT),
        task: a.task,
        name: a.name,
        ...(a.cwd ? { cwd: a.cwd } : {}),
        ...(a.model ? { model: a.model } : {}),
      });
      const sessionFile = (result.details as { sessionFile?: unknown } | undefined)?.sessionFile;
      return { sessionFile: typeof sessionFile === "string" ? sessionFile : undefined };
    },
    sendToChild: async (name, message) => {
      await run("subagent_message", { name, message });
    },
    confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
  };
}

/** Tools that exist in every session that can spawn. */
export function spawnerTools(svc: () => ThreadService): ToolDef[] {
  const spawnThread = tool({
    name: "spawn_thread",
    label: "Spawn thread",
    description:
      'Start a child thread (a sub-agent in its own pane) for work that can run in parallel, and return at once. Pass child_of: your own thread stack, root first (in the main session that is ["root"]); a mismatch is rejected. ' +
      "fresh_context: true starts the child with an empty history, so write self-contained instructions; use it for independent tasks and when your conversation is long. Otherwise the child inherits your conversation. " +
      "sandbox: true gives the child its own git worktree and branch. depends_on lists direct children that must have completed without a known failure; interactive completion does not verify success. An unmet dependency rejects the call rather than queueing it. Reports and the close arrive as [infinity event] messages. Never wait for it.",
    promptGuidelines: [
      "Prefer fresh_context threads for independent sub-tasks: a long parent conversation is noise that costs tokens. Put every path and fact the child needs into its instructions.",
      "For large inputs, keep sources in files; inspect metadata and search first, use scripts for exact aggregation, and delegate only unresolved bounded portions. Request source locations and coverage, limit fanout, and check missing or failed portions before claiming coverage; a child closing does not prove success.",
      "Record inspected, skipped, and unresolved portions and reconcile assigned and reported ranges with assess_coverage. Reports and coverage are unverified; check citations against sources.",
      "After spawn_thread, do not poll or guess results. End your turn or work on something independent.",
    ],
    parameters: Type.Object({
      instructions: Type.String({ description: "What the child must do. Self-contained when fresh_context is true" }),
      child_of: Type.Array(Type.String(), { description: "Your full thread stack, root first" }),
      fresh_context: Type.Optional(Type.Boolean({ description: "Empty history for the child. Default false" })),
      model: Type.Optional(Type.String({ description: "Model override for the child" })),
      sandbox: Type.Optional(Type.Boolean({ description: "Give the child an isolated git worktree. Needs a git repo" })),
      depends_on: Type.Optional(
        Type.Array(Type.String(), { description: "Direct child IDs that must already have completed without a known failure" }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const context = ctx as unknown as ToolCtx;
      const model = scopedModel(params.model, context.model, context.scopedModels ?? []);
      const out = await svc().spawn(
        { ...params, ...(model === undefined ? {} : { model }) },
        ioFor(context, svc().transportSetting, toolCallId),
      );
      return { content: [{ type: "text", text: out.text }], details: { id: out.id } };
    },
  });

  const sendToChild = tool({
    name: "send_message_to_child",
    label: "Message child",
    description:
      "Send a message to one of your running direct child threads. Returns at once. Closed threads cannot be resumed; spawn a new thread instead.",
    parameters: Type.Object({ thread_id: Type.String(), message: Type.String() }),
    async execute(toolCallId, params, _s, _u, ctx) {
      await svc().sendToChild(params.thread_id, params.message, ioFor(ctx as unknown as ToolCtx, svc().transportSetting, toolCallId));
      return { content: [{ type: "text", text: `Message sent to ${params.thread_id}.` }], details: {} };
    },
  });

  const squash = tool({
    name: "squash_sandbox",
    label: "Squash sandbox",
    description:
      "Merge a finished child's sandbox branch into your working tree. If you are a sandboxed thread the result is committed. In the main session the user must confirm first. On conflict the sandbox is preserved and the target may need manual recovery.",
    parameters: Type.Object({
      thread_id: Type.String(),
      commit: Type.Optional(Type.Boolean({ description: "Commit the result (sandboxed callers only, default true)" })),
    }),
    async execute(toolCallId, params, _s, _u, ctx) {
      const text = await svc().squash(
        params.thread_id,
        { commit: params.commit },
        ioFor(ctx as unknown as ToolCtx, svc().transportSetting, toolCallId),
      );
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  return [spawnThread, sendToChild, squash];
}

const structuredReport = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    files: Type.Optional(Type.Array(Type.String())),
    tests: Type.Optional(Type.Array(Type.String())),
    blockers: Type.Optional(Type.Array(Type.String())),
    evidence: Type.Optional(
      Type.Array(
        Type.Object(
          {
            source: Type.String({ minLength: 1 }),
            start: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            end: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            claim: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    coverage: Type.Optional(
      Type.Array(
        Type.Object(
          {
            source: Type.String({ minLength: 1 }),
            start: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            end: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            status: Type.Union([Type.Literal("read"), Type.Literal("partial"), Type.Literal("failed")]),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

/** Tools that exist only inside a thread session. */
export function childTools(svc: () => ThreadService): ToolDef[] {
  const report = tool({
    name: "report_to_parent",
    label: "Report to parent",
    description:
      "Send an intermediate result to your parent thread without ending your session. The parent sees it as an [infinity event] message.",
    parameters: Type.Object({ report: Type.Optional(Type.String()), structured: Type.Optional(structuredReport) }),
    async execute(_id, params) {
      svc().report(encodeReport(params.report, params.structured, true)!);
      return { content: [{ type: "text", text: "Report sent to the parent thread." }], details: {} };
    },
  });

  const close = tool({
    name: "close_thread",
    label: "Close thread",
    description: "Finish this thread. Pass a short final report for the parent. Calling this ends your session, so do it last.",
    parameters: Type.Object({
      report: Type.Optional(Type.String({ description: "Final report for the parent" })),
      structured: Type.Optional(structuredReport),
    }),
    async execute(_id, params) {
      svc().close(encodeReport(params.report, params.structured, false));
      return { content: [{ type: "text", text: "Thread closed. Your report was sent to the parent." }], details: {}, terminate: true };
    },
  });

  return [report, close];
}

export function textFromOutcome(result: { content: Array<{ type: string; text?: string }> }): string {
  return textOf(result);
}
