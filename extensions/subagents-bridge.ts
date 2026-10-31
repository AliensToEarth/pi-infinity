import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./lib/log.ts";
import { agentDir } from "./runtime.ts";

interface SubagentsGlobal {
  registerToolExtension?: (name: string, path: string) => void;
}

const REQUIRED_AGENTS = ["thread-fresh", "thread-fork"];

/**
 * R-H2, R-H9. Child processes start with --no-extensions and an allowlist, so every tool
 * a thread may call must be mapped to the file that registers it. The subagents extension
 * exposes registerToolExtension on a process global for exactly this.
 */
export function registerWithSubagents(toolNames: string[], logger: Logger, warn: (message: string) => void, activeTools: string[]): void {
  const hasSubagents = activeTools.includes("subagent") && activeTools.includes("subagent_message");
  if (!hasSubagents) {
    warn("pi-infinity: the subagent tools were not found, so spawn_thread cannot work. Install pi-interactive-subagents.");
    return;
  }
  const bridge = (globalThis as { __pi_interactive_subagents?: SubagentsGlobal }).__pi_interactive_subagents;
  if (!bridge?.registerToolExtension) {
    warn("pi-infinity: pi-interactive-subagents does not expose registerToolExtension, threads would start without pi-infinity tools.");
    return;
  }
  const self = fileURLToPath(new URL("./index.ts", import.meta.url));
  for (const name of toolNames) {
    try {
      bridge.registerToolExtension(name, self);
    } catch (err) {
      logger.error("subagents-bridge", err);
    }
  }
  const missing = REQUIRED_AGENTS.filter((a) => !existsSync(join(agentDir(), "agents", `${a}.md`)));
  if (missing.length > 0)
    warn(`pi-infinity: agent definitions missing (${missing.join(", ")}). Run scripts/install.sh from the pi-infinity repo.`);
}
