import { readFileSync } from "node:fs";
import type { DetachedLaunch } from "./thread-service.ts";
import type { AgentRegistry } from "./transport.ts";

export const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
/** The default pi-subagents uses when an agent names no model. */
export const FALLBACK_MODEL = "anthropic/claude-sonnet-4-6";

export type ExecuteTool = (
  name: string,
  args: unknown,
  options?: { signal?: AbortSignal },
) => Promise<{ isError: boolean; result: { content: Array<{ type: string; text?: string }> } }>;

/** Body of an agent markdown file, without the frontmatter. */
export function promptBody(markdown: string): string {
  const m = markdown.match(/^---\n[\s\S]*?\n---\n?/);
  return (m ? markdown.slice(m[0].length) : markdown).trim();
}

export function loadBlockingPrompt(file: string): string {
  return promptBody(readFileSync(file, "utf8"));
}

export interface LaunchInput {
  registry: AgentRegistry;
  executeTool: ExecuteTool;
  id: string;
  task: string;
  cwd?: string;
  /** From the spawn call, else the session model. */
  model?: string;
  sessionModel?: string;
  systemPrompt: string;
  promptFile: string;
}

/**
 * R-X3, R-X4. Registers a one-thread agent, starts the blocking `subagent` call without
 * awaiting it, and unregisters the agent when the call settles. The call has its own
 * AbortController because the signal of the spawning tool call ends with that call.
 */
export function launchViaSubagents(i: LaunchInput): DetachedLaunch {
  const name = `thread-${i.id}`;
  i.registry.registerAgent({
    name,
    description: "pi-infinity worker thread",
    tools: [...BUILTIN_TOOLS],
    model: i.model ?? i.sessionModel ?? FALLBACK_MODEL,
    thinking: "medium",
    systemPrompt: i.systemPrompt,
    filePath: i.promptFile,
  });
  const controller = new AbortController();
  const args = { agent: name, task: i.task, ...(i.cwd ? { cwd: i.cwd } : {}) };
  const done = i
    .executeTool("subagent", args, { signal: controller.signal })
    .then((outcome) => ({
      output: outcome.result.content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim(),
      isError: outcome.isError,
    }))
    .catch((err: unknown) => ({ output: `subagent call failed: ${(err as Error).message ?? String(err)}`, isError: true }))
    .finally(() => i.registry.unregisterAgent(name));
  return { done, abort: () => controller.abort() };
}
