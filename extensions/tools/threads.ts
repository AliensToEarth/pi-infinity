import { Type } from "typebox";
import type { ThreadIO, ThreadService } from "../lib/thread-service.ts";
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
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("\n")
    .trim();
}

function ioFor(ctx: ToolCtx, callId?: string): ThreadIO {
  const run = async (name: string, args: unknown) => {
    const outcome = await ctx.executeTool(name, args);
    if (outcome.isError) throw new Error(`${name} failed: ${textOf(outcome.result)}`);
    return outcome.result;
  };
  return {
    cwd: ctx.cwd,
    callId,
    launch: async (a) => {
      const result = await run("subagent", {
        agent: a.agent,
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
      "sandbox: true gives the child its own git worktree and branch. Reports and the close arrive as [infinity event] messages. Never wait for it.",
    promptGuidelines: [
      "Prefer fresh_context threads for independent sub-tasks: a long parent conversation is noise that costs tokens. Put every path and fact the child needs into its instructions.",
      "After spawn_thread, do not poll or guess results. End your turn or work on something independent.",
    ],
    parameters: Type.Object({
      instructions: Type.String({ description: "What the child must do. Self-contained when fresh_context is true" }),
      child_of: Type.Array(Type.String(), { description: "Your full thread stack, root first" }),
      fresh_context: Type.Optional(Type.Boolean({ description: "Empty history for the child. Default false" })),
      model: Type.Optional(Type.String({ description: "Model override for the child" })),
      sandbox: Type.Optional(Type.Boolean({ description: "Give the child an isolated git worktree. Needs a git repo" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const out = await svc().spawn(params, ioFor(ctx as unknown as ToolCtx, toolCallId));
      return { content: [{ type: "text", text: out.text }], details: { id: out.id } };
    },
  });

  const sendToChild = tool({
    name: "send_message_to_child",
    label: "Message child",
    description:
      "Send a message to one of your direct child threads. It is typed into the running child, or resumes the child if it has finished. Returns at once.",
    parameters: Type.Object({ thread_id: Type.String(), message: Type.String() }),
    async execute(toolCallId, params, _s, _u, ctx) {
      await svc().sendToChild(params.thread_id, params.message, ioFor(ctx as unknown as ToolCtx, toolCallId));
      return { content: [{ type: "text", text: `Message sent to ${params.thread_id}.` }], details: {} };
    },
  });

  const squash = tool({
    name: "squash_sandbox",
    label: "Squash sandbox",
    description:
      "Merge a finished child's sandbox branch into your working tree with git merge --squash. If you are a sandboxed thread the result is committed. In the main session the changes are only staged, and the user must confirm first. Conflicts abort and leave both sides unchanged.",
    parameters: Type.Object({
      thread_id: Type.String(),
      commit: Type.Optional(Type.Boolean({ description: "Commit the result (sandboxed callers only, default true)" })),
    }),
    async execute(toolCallId, params, _s, _u, ctx) {
      const text = await svc().squash(params.thread_id, { commit: params.commit }, ioFor(ctx as unknown as ToolCtx, toolCallId));
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  return [spawnThread, sendToChild, squash];
}

/** Tools that exist only inside a thread session. */
export function childTools(svc: () => ThreadService): ToolDef[] {
  const report = tool({
    name: "report_to_parent",
    label: "Report to parent",
    description:
      "Send an intermediate result to your parent thread without ending your session. The parent sees it as an [infinity event] message.",
    parameters: Type.Object({ report: Type.String() }),
    async execute(_id, params) {
      svc().report(params.report);
      return { content: [{ type: "text", text: "Report sent to the parent thread." }], details: {} };
    },
  });

  const close = tool({
    name: "close_thread",
    label: "Close thread",
    description: "Finish this thread. Pass a short final report for the parent. Calling this ends your session, so do it last.",
    parameters: Type.Object({ report: Type.Optional(Type.String({ description: "Final report for the parent" })) }),
    async execute(_id, params) {
      svc().close(params.report);
      return { content: [{ type: "text", text: "Thread closed. Your report was sent to the parent." }], details: {}, terminate: true };
    },
  });

  return [report, close];
}

export function textFromOutcome(result: { content: Array<{ type: string; text?: string }> }): string {
  return textOf(result);
}
