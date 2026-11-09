import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./lib/log.ts";
import { agentDir } from "./runtime.ts";
import { pickTransport, readAgentRegistry, type Transport, type TransportSetting } from "./lib/transport.ts";

interface SubagentsGlobal {
  registerToolExtension?: (name: string, path: string) => void;
}

const REQUIRED_AGENTS = ["thread-fresh", "thread-fork", "thread-fresh-nested", "thread-fork-nested"];

export function installAgents(directory: string, logger: Logger, warn: (message: string) => void): void {
  const targetDir = join(directory, "agents");
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    logger.error("subagents-bridge", err);
    warn(`pi-infinity: cannot create agent directory ${targetDir}`);
    return;
  }
  for (const agent of REQUIRED_AGENTS) {
    const source = fileURLToPath(new URL(`../agents/${agent}.md`, import.meta.url));
    const target = join(targetDir, `${agent}.md`);
    try {
      symlinkSync(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          if (realpathSync(target) === realpathSync(source)) continue;
        } catch (checkError) {
          logger.error("subagents-bridge", checkError);
        }
        warn(`pi-infinity: agent ${target} already exists and was not replaced`);
      } else {
        logger.error("subagents-bridge", err);
        warn(`pi-infinity: cannot install agent ${target}`);
      }
    }
  }
}

/**
 * R-H2, R-H9. Child processes start with --no-extensions and an allowlist, so every tool
 * a thread may call must be mapped to the file that registers it. The subagents extension
 * exposes registerToolExtension on a process global for exactly this.
 */
export function registerWithSubagents(
  toolNames: string[],
  logger: Logger,
  warn: (message: string) => void,
  activeTools: string[],
  setting: TransportSetting = "auto",
): Transport {
  const transport = pickTransport(setting, activeTools, readAgentRegistry() !== undefined);
  if (transport === "none") {
    warn(
      "pi-infinity: no usable subagent extension found, so spawn_thread cannot work. " +
        "Install pi-interactive-subagents or pi-subagents (see threads.transport in infinity.json).",
    );
    return transport;
  }
  // pi-subagents has no hook to hand tools to its children. Nothing to register.
  if (transport === "subagents") return transport;

  const bridge = (globalThis as { __pi_interactive_subagents?: SubagentsGlobal }).__pi_interactive_subagents;
  if (!bridge?.registerToolExtension) {
    warn("pi-infinity: pi-interactive-subagents does not expose registerToolExtension, threads would start without pi-infinity tools.");
    return transport;
  }
  const self = fileURLToPath(new URL("./index.ts", import.meta.url));
  for (const name of toolNames) {
    try {
      bridge.registerToolExtension(name, self);
    } catch (err) {
      logger.error("subagents-bridge", err);
    }
  }
  installAgents(agentDir(), logger, warn);
  return transport;
}
