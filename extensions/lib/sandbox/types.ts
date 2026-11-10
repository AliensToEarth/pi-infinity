export interface Sandbox {
  id: string;
  branch: string;
  path: string;
  base: string;
  repoRoot: string;
}

export type SquashResult = { ok: true; commitSha?: string; filesChanged: number } | { ok: false; conflicts: string[]; error?: string };

export interface SandboxInfo {
  branch: string;
  id: string;
  path?: string;
  merged: boolean;
  hasWorktree: boolean;
}

export interface SandboxBackend {
  readonly name: string;
  detect(cwd: string): Promise<{ repoRoot: string } | null>;
  create(opts: { cwd: string; id: string; base?: string; root?: string }): Promise<Sandbox>;
  commitAll(sb: Sandbox, message: string): Promise<{ committed: boolean; sha?: string }>;
  diffStat(sb: Sandbox): Promise<string>;
  squashInto(targetPath: string, sb: Sandbox, opts: { commit: boolean; message?: string }): Promise<SquashResult>;
  remove(sb: Sandbox, opts: { keepBranch: boolean }): Promise<void>;
  list(repoRoot: string): Promise<SandboxInfo[]>;
  pruneMerged(repoRoot: string): Promise<string[]>;
  /**
   * True when `path` holds applied sandbox work that is not committed yet. Pruning is
   * refused then, because a squashed branch may be the only copy.
   */
  hasPendingWork?(path: string): Promise<boolean>;
}

// Ids come from model-influenced input and become branch names, config keys and
// directories. The pattern allows no separators, dots or whitespace, so an id can
// never traverse out of the sandbox root or break a config key.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;

export function validateSandboxId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid sandbox id ${JSON.stringify(id)}, must match ${ID_PATTERN.source}`);
  }
}
