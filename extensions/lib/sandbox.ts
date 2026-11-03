// Git sandbox backend (SPEC 5.6, practice P10). Each sandbox is a git worktree on
// a sandbox-<id> branch, so parallel edits never touch the user's working copy.
// Pure core: no pi imports, every git call goes through execFile with an argument
// array, never a shell string.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "./log.ts";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_ROOT = ".pi/sandboxes";
const PREFIX = "sandbox-";
const SQUASHED_KEY = "pi-infinity-squashed";
const BASE_KEY = "pi-infinity-base";

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

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function toGitRun(err: unknown): GitRun {
  if (typeof err !== "object" || err === null) {
    throw new Error(`bug: execFile rejected with a non-object error: ${String(err)}`);
  }
  const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
  const stdout = typeof e.stdout === "string" ? e.stdout : "";
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  if (e.code === "ENOENT") {
    // git is not on PATH. Synthesize a stderr so the cause is not lost.
    return { code: 127, stdout, stderr: stderr === "" ? "git executable not found" : stderr };
  }
  if (typeof e.code === "number") return { code: e.code, stdout, stderr };
  // Killed by a signal (code is null): treat as a failure without an exit status.
  return { code: 143, stdout, stderr };
}

type GitEnv = typeof process.env;

// Runs git and reports the exit code instead of throwing, for yes/no probes.
async function run(cwd: string, args: string[], env: GitEnv): Promise<GitRun> {
  try {
    const r = await execFileAsync("git", args, { cwd, env, encoding: "utf8", maxBuffer: MAX_BUFFER });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    return toGitRun(err);
  }
}

// Runs git and throws an Error whose message carries the command's stderr.
async function git(cwd: string, args: string[], env: GitEnv): Promise<string> {
  const r = await run(cwd, args, env);
  if (r.code !== 0) {
    const hint = r.stderr.trim() !== "" ? r.stderr.trim() : r.stdout.trim();
    throw new Error(`git ${args.join(" ")} in ${cwd} failed with exit code ${r.code}: ${hint}`);
  }
  return r.stdout;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

export class GitSandbox implements SandboxBackend {
  readonly name = "git";
  private readonly logger: Logger;
  private readonly env: GitEnv;

  // The environment is injectable so tests can isolate the machine's global git
  // config, following the injected-clock-and-spawner rule for lib modules.
  constructor(logger: Logger, env: GitEnv = process.env) {
    this.logger = logger;
    this.env = env;
  }

  async detect(cwd: string): Promise<{ repoRoot: string } | null> {
    // --show-toplevel reports the containing worktree, so detection from inside a
    // sandbox yields that worktree's toplevel, which is what the caller wants.
    const r = await run(cwd, ["rev-parse", "--show-toplevel"], this.env);
    if (r.code !== 0) return null; // not a repository, or git is missing
    const repoRoot = r.stdout.trim();
    return repoRoot === "" ? null : { repoRoot };
  }

  async create(opts: { cwd: string; id: string; base?: string; root?: string }): Promise<Sandbox> {
    const { cwd, id } = opts;
    validateSandboxId(id);
    const branch = `${PREFIX}${id}`;
    const root = opts.root ?? DEFAULT_ROOT;

    // Sandboxes always live under the MAIN checkout, even when cwd is itself a
    // linked worktree, so the main root is derived from --git-common-dir rather
    // than --show-toplevel (which would point at the calling worktree).
    const commonDir = await this.gitCommonDir(cwd);
    const mainRoot = dirname(commonDir);
    const path = isAbsolute(root) ? resolve(root, id) : resolve(mainRoot, root, id);

    if (existsSync(path)) {
      throw new Error(`cannot create sandbox ${id}: path ${path} already exists`);
    }
    const branchProbe = await run(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`], this.env);
    if (branchProbe.code === 0) {
      throw new Error(`cannot create sandbox ${id}: branch ${branch} already exists`);
    }

    const baseSpec = opts.base ?? "HEAD";
    if (baseSpec === "HEAD") {
      const headProbe = await run(cwd, ["rev-parse", "--verify", "HEAD"], this.env);
      if (headProbe.code !== 0) {
        throw new Error(`cannot create sandbox ${id}: the repository has no commits`);
      }
    }
    let base = "";
    try {
      // Resolve to a sha so later diffs stay stable even if a named ref moves.
      base = (await git(cwd, ["rev-parse", "--verify", `${baseSpec}^{commit}`], this.env)).trim();
    } catch (err) {
      throw new Error(`cannot create sandbox ${id}: cannot resolve base ${JSON.stringify(baseSpec)}: ${message(err)}`);
    }

    this.excludeRoot(commonDir, root);
    mkdirSync(dirname(path), { recursive: true });
    // A failed add does not prove ownership of either the path or the branch:
    // another process may have created them after our probes. Leave any partial
    // artifacts for manual recovery instead of risking deletion of user work.
    await git(cwd, ["worktree", "add", "-b", branch, path, base], this.env);
    // Lets list() tell an untouched branch (tip equals base) from one that was merged.
    await git(mainRoot, ["config", `branch.${branch}.${BASE_KEY}`, base], this.env);
    return { id, branch, path, base, repoRoot: mainRoot };
  }

  async commitAll(sb: Sandbox, msg: string): Promise<{ committed: boolean; sha?: string }> {
    await git(sb.path, ["add", "-A"], this.env);
    const status = await git(sb.path, ["status", "--porcelain"], this.env);
    if (status.trim() === "") return { committed: false };
    const sha = await this.commit(sb.path, msg);
    return { committed: true, sha };
  }

  async diffStat(sb: Sandbox): Promise<string> {
    // Diff the working tree against the base commit: one command that covers both
    // committed and uncommitted changes in the sandbox.
    const out = await git(sb.path, ["diff", "--stat", sb.base], this.env);
    const text = out.trim();
    return text === "" ? "(no changes)" : text;
  }

  async squashInto(targetPath: string, sb: Sandbox, opts: { commit: boolean; message?: string }): Promise<SquashResult> {
    const status = await git(targetPath, ["status", "--porcelain"], this.env);
    if (status.trim() !== "") {
      return {
        ok: false,
        conflicts: [],
        error: `refusing to squash into ${targetPath}: it has uncommitted or staged changes, sandbox work must never be mixed with user work`,
      };
    }
    const sourceStatus = await git(sb.path, ["status", "--porcelain"], this.env);
    if (sourceStatus.trim() !== "") {
      return {
        ok: false,
        conflicts: [],
        error: `refusing to squash dirty sandbox ${sb.path}: commit or preserve its uncommitted changes first`,
      };
    }
    // Pin both the merge and its marker to the same tip, even if the branch moves
    // while the merge is running.
    const tip = (await git(targetPath, ["rev-parse", "--verify", `refs/heads/${sb.branch}^{commit}`], this.env)).trim();
    const merge = await run(targetPath, ["merge", "--squash", "--no-overwrite-ignore", tip], this.env);
    if (merge.code !== 0) {
      const conflicts = lines(await git(targetPath, ["diff", "--name-only", "--diff-filter=U"], this.env));
      // Concurrent edits may have appeared after the clean-tree check. Do not
      // reset them along with the failed squash.
      const hint = merge.stderr.trim() !== "" ? merge.stderr.trim() : merge.stdout.trim();
      return {
        ok: false,
        conflicts,
        error: `${hint}\nNo automatic reset was performed; manual recovery may be required in ${targetPath}.`,
      };
    }
    const staged = lines(await git(targetPath, ["diff", "--cached", "--name-only"], this.env));
    let commitSha: string | undefined;
    if (opts.commit) {
      commitSha = await this.commit(targetPath, opts.message ?? `squash ${sb.branch}`);
    }
    // The marker is informational for list(); it does not prove that the
    // applied work survives and must not authorize pruning.
    await git(targetPath, ["config", `branch.${sb.branch}.${SQUASHED_KEY}`, tip], this.env);
    return { ok: true, commitSha, filesChanged: staged.length };
  }

  async remove(sb: Sandbox, opts: { keepBranch: boolean }): Promise<void> {
    // Check existence first instead of ignoring a not-found error, so real
    // failures still surface.
    if (existsSync(sb.path)) {
      const ignored = await git(sb.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], this.env);
      if (ignored.trim()) throw new Error(`refusing to remove sandbox ${sb.path}: it contains ignored files`);
      await git(sb.repoRoot, ["worktree", "remove", sb.path], this.env);
    }
    try {
      await git(sb.repoRoot, ["worktree", "prune"], this.env);
    } catch (err) {
      // Prune is best-effort cleanup once the worktree is already gone.
      this.logger.error("sandbox", err);
    }
    if (!opts.keepBranch) {
      await git(sb.repoRoot, ["branch", "-D", sb.branch], this.env);
    }
  }

  async list(repoRoot: string): Promise<SandboxInfo[]> {
    const refs = await git(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/sandbox-*"], this.env);
    const worktrees = await this.worktreeBranches(repoRoot);
    const infos: SandboxInfo[] = [];
    for (const branch of lines(refs)) {
      const path = worktrees.get(branch);
      infos.push({
        branch,
        id: branch.slice(PREFIX.length),
        path,
        merged: await this.isMerged(repoRoot, branch),
        hasWorktree: path !== undefined,
      });
    }
    return infos;
  }

  async hasPendingWork(path: string): Promise<boolean> {
    const status = await git(path, ["status", "--porcelain"], this.env);
    return status.trim() !== "";
  }

  async pruneMerged(repoRoot: string): Promise<string[]> {
    const paths = await this.worktreePaths(repoRoot);
    for (const path of paths) {
      if (await this.hasPendingWork(path)) throw new Error(`refusing to prune: worktree ${path} has uncommitted changes`);
    }
    const infos = await this.list(repoRoot);
    const deleted: string[] = [];
    for (const info of infos) {
      if (info.hasWorktree) continue;
      const ref = `refs/heads/${info.branch}`;
      const tip = (await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`], this.env)).trim();
      if (!(await this.isAncestorPastBase(repoRoot, info.branch, tip))) continue;
      await git(repoRoot, ["update-ref", "-d", ref, tip], this.env);
      deleted.push(info.branch);
    }
    return deleted;
  }

  private async gitCommonDir(cwd: string): Promise<string> {
    const r = await run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], this.env);
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() !== "" ? r.stderr.trim() : `${cwd} is not inside a git repository`);
    }
    return r.stdout.trim().replace(/\/+$/, "");
  }

  // R-S2: keep the sandbox root out of git status. Appended once, so repeated
  // creates do not duplicate the line.
  private excludeRoot(commonDir: string, root: string): void {
    const line = `${root.replace(/\/+$/, "")}/`;
    const excludePath = join(commonDir, "info", "exclude");
    mkdirSync(dirname(excludePath), { recursive: true });
    const content = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (content.split("\n").includes(line)) return;
    const sep = content === "" || content.endsWith("\n") ? "" : "\n";
    writeFileSync(excludePath, `${content}${sep}${line}\n`);
  }

  private async commit(dir: string, msg: string): Promise<string> {
    // R-S3: hooks and signing are disabled so background commits never stall or
    // fail on repository state the agent did not create.
    const args = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
    if (!(await this.hasIdentity(dir))) {
      args.push("-c", "user.name=pi-infinity", "-c", "user.email=pi-infinity@invalid");
    }
    args.push("commit", "-m", msg);
    await git(dir, args, this.env);
    return (await git(dir, ["rev-parse", "HEAD"], this.env)).trim();
  }

  private async hasIdentity(dir: string): Promise<boolean> {
    const name = await run(dir, ["config", "user.name"], this.env);
    const email = await run(dir, ["config", "user.email"], this.env);
    return name.code === 0 && name.stdout.trim() !== "" && email.code === 0 && email.stdout.trim() !== "";
  }

  private async worktreePaths(repoRoot: string): Promise<string[]> {
    const out = await git(repoRoot, ["worktree", "list", "--porcelain", "-z"], this.env);
    return out
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length));
  }

  private async worktreeBranches(repoRoot: string): Promise<Map<string, string>> {
    const out = await git(repoRoot, ["worktree", "list", "--porcelain"], this.env);
    const map = new Map<string, string>();
    for (const block of out.split("\n\n")) {
      let path = "";
      let branch = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        if (line.startsWith("branch ")) {
          branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        }
      }
      if (path !== "" && branch !== "") map.set(branch, path);
    }
    return map;
  }

  private async isMerged(repoRoot: string, branch: string, pinnedTip?: string): Promise<boolean> {
    const tip = pinnedTip ?? (await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], this.env)).trim();
    const marker = await run(repoRoot, ["config", `branch.${branch}.${SQUASHED_KEY}`], this.env);
    if (marker.code === 0 && /^[0-9a-f]{40,64}$/.test(marker.stdout.trim())) {
      if (tip === marker.stdout.trim()) return true;
    }
    return this.isAncestorPastBase(repoRoot, branch, tip);
  }

  private async isAncestorPastBase(repoRoot: string, branch: string, tip: string): Promise<boolean> {
    const base = await run(repoRoot, ["config", `branch.${branch}.${BASE_KEY}`], this.env);
    if (base.code !== 0 || !/^[0-9a-f]{40,64}$/.test(base.stdout.trim()) || tip === base.stdout.trim()) return false;
    const ancestor = await run(repoRoot, ["merge-base", "--is-ancestor", tip, "HEAD"], this.env);
    if (ancestor.code === 1) return false;
    if (ancestor.code !== 0) throw new Error(`git merge-base --is-ancestor failed: ${ancestor.stderr.trim()}`);
    return true;
  }
}
