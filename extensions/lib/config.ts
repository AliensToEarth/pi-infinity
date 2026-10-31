import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./log.ts";

export interface InfinityConfig {
  bash: { guard: "block" | "warn" | "off"; defaultTimeoutSec: number; sleepLimitSec: number };
  jobs: { max: number; tailLines: number; watchDebounceMs: number; watchBatchLines: number; watchEventsPerMin: number };
  events: { maxChars: number; seenCap: number };
  overflow: { maxChars: number; headChars: number; tailChars: number };
  timers: { max: number };
  threads: { enabled: boolean; maxDepth: number; transport: "auto" | "interactive" | "subagents" };
  sandbox: { root: string; autoCommit: boolean; backend: "auto" | "git" | "jj" };
}

export const DEFAULT_CONFIG: InfinityConfig = {
  bash: { guard: "block", defaultTimeoutSec: 180, sleepLimitSec: 20 },
  jobs: { max: 8, tailLines: 40, watchDebounceMs: 1000, watchBatchLines: 20, watchEventsPerMin: 6 },
  events: { maxChars: 4000, seenCap: 2000 },
  overflow: { maxChars: 40000, headChars: 6000, tailChars: 2000 },
  timers: { max: 32 },
  threads: { enabled: true, maxDepth: 4, transport: "auto" },
  sandbox: { root: ".pi/sandboxes", autoCommit: true, backend: "auto" },
};

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep merge `override` into a clone of `base`. A value is accepted only when its
 * type matches the default. Mismatches and unknown keys are collected in `problems`.
 */
export function mergeConfig<T extends Json>(base: T, override: unknown, path: string, problems: string[]): T {
  const out: Json = structuredClone(base);
  if (override === undefined) return out as T;
  if (!isObject(override)) {
    problems.push(`${path || "(root)"}: expected an object`);
    return out as T;
  }
  for (const [key, value] of Object.entries(override)) {
    const here = path ? `${path}.${key}` : key;
    if (!(key in base)) {
      problems.push(`${here}: unknown key`);
      continue;
    }
    const def = base[key];
    if (isObject(def)) {
      out[key] = mergeConfig(def, value, here, problems);
    } else if (typeof def === typeof value) {
      if (key === "guard" && !["block", "warn", "off"].includes(value as string)) {
        problems.push(`${here}: must be block, warn or off`);
      } else if (key === "transport" && !["auto", "interactive", "subagents"].includes(value as string)) {
        problems.push(`${here}: must be auto, interactive or subagents`);
      } else if (key === "backend" && !["auto", "git", "jj"].includes(value as string)) {
        problems.push(`${here}: must be auto, git or jj`);
      } else if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
        problems.push(`${here}: must be a non-negative number`);
      } else {
        out[key] = value;
      }
    } else {
      problems.push(`${here}: expected ${typeof def}`);
    }
  }
  return out as T;
}

export interface LoadedConfig {
  config: InfinityConfig;
  problems: string[];
}

function readJson(file: string, problems: string[], logger: Logger): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    logger.error("config", err);
    problems.push(`${file}: unreadable`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.error("config", err);
    problems.push(`${file}: invalid JSON`);
    return undefined;
  }
}

export function loadConfig(
  cwd: string,
  logger: Logger,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): LoadedConfig {
  const problems: string[] = [];
  let config: InfinityConfig = structuredClone(DEFAULT_CONFIG);
  for (const file of [join(agentDir, "infinity.json"), join(cwd, ".pi", "infinity.json")]) {
    const json = readJson(file, problems, logger);
    if (json !== undefined) config = mergeConfig(config as unknown as Json, json, "", problems) as unknown as InfinityConfig;
  }
  return { config, problems };
}
