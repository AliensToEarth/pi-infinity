/** Which subagent extension carries threads. */
export type Transport = "interactive" | "subagents" | "none";
export type TransportSetting = "auto" | "interactive" | "subagents";

/**
 * R-X1. Pick the transport from what is installed.
 *
 * interactive: pi-interactive-subagents, recognized by its `subagent_message` tool.
 * subagents: pi-subagents, recognized by a `subagent` tool plus the runtime
 * registry on `globalThis.__pi_subagents`.
 */
export function pickTransport(setting: TransportSetting, toolNames: readonly string[], hasAgentRegistry: boolean): Transport {
  const has = (name: string) => toolNames.includes(name);
  const interactive = has("subagent") && has("subagent_message");
  const subagents = has("subagent") && hasAgentRegistry;
  if (setting === "interactive") return interactive ? "interactive" : "none";
  if (setting === "subagents") return subagents ? "subagents" : "none";
  if (interactive) return "interactive";
  return subagents ? "subagents" : "none";
}

export const NO_TRANSPORT_MESSAGE =
  "spawn_thread needs a subagent extension. Install pi-interactive-subagents (tmux panes, live reports) " +
  "or pi-subagents (headless, final report only). If both are missing or threads.transport excludes the installed one, it cannot run.";

export interface AgentRegistry {
  registerAgent(config: {
    name: string;
    description: string;
    tools: string[];
    model: string;
    thinking: string;
    systemPrompt: string;
    filePath: string;
  }): void;
  unregisterAgent(name: string): void;
}

/** Reads the registry pi-subagents publishes. Undefined when it is not loaded. */
export function readAgentRegistry(g: object = globalThis): AgentRegistry | undefined {
  const reg = (g as { __pi_subagents?: Partial<AgentRegistry> }).__pi_subagents;
  if (reg && typeof reg.registerAgent === "function" && typeof reg.unregisterAgent === "function") return reg as AgentRegistry;
  return undefined;
}
