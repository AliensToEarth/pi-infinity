// Jujutsu sandbox backend (SPEC 5.6, backlog B-1). Each sandbox is a jj
// workspace whose working-copy change carries the sandbox-<id> bookmark, so
// parallel edits never touch the user's working copy. Mirrors the git backend
// (same SandboxBackend shape, error style and requirement ids), but every jj
// call goes through execFile with an argument array, never a shell string.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "./log.ts";
import { validateSandboxId } from "./sandbox.ts";
import type { Sandbox, SandboxBackend, SandboxInfo, SquashResult } from "./sandbox.ts";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_ROOT = ".pi/sandboxes";
const PREFIX = "sandbox-";
// Squash bookkeeping lives in the main .jj directory: jj never snapshots .jj
// and colocated git ignores it via .jj/.gitignore, so the marker can never
// dirty the user's working copy.
const MARKER_NAME = "pi-infinity-squashed.json";

interface ToolRun {
  code: number;
  stdout: string;
  stderr: string;
}

function toToolRun(err: unknown, tool: string): ToolRun {
  if (typeof err !== "object" || err === null) {
    throw new Error(`bug: execFile rejected with a non-object error: ${String(err)}`);
  }
  const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
  const stdout = typeof e.stdout === "string" ? e.stdout : "";
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  if (e.code === "ENOENT") {
    // The tool is not on PATH. Synthesize a stderr so the cause is not lost.
    return { code: 127, stdout, stderr: stderr === "" ? `${tool} executable not found` : stderr };
  }
  if (typeof e.code === "number") return { code: e.code, stdout, stderr };
  // Killed by a signal (code is null): treat as a failure without an exit status.
  return { code: 143, stdout, stderr };
}

type JjEnv = typeof process.env;

// Runs jj and reports the exit code instead of throwing, for yes/no probes.
async function jjRun(cwd: string, args: string[], env: JjEnv): Promise<ToolRun> {
  // Machine-readable output regardless of the user's pager and color config.
  const full = ["--no-pager", "--color=never", ...args];
  try {
    const r = await execFileAsync("jj", full, { cwd, env, encoding: "utf8", maxBuffer: MAX_BUFFER });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    return toToolRun(err, "jj");
  }
}

// Runs git (only for colocated worktree cleanup) with the same exit-code shape.
async function gitRun(cwd: string, args: string[], env: JjEnv): Promise<ToolRun> {
  try {
    const r = await execFileAsync("git", args, { cwd, env, encoding: "utf8", maxBuffer: MAX_BUFFER });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    return toToolRun(err, "git");
  }
}

// Runs jj and throws an Error whose message carries the command's stderr.
async function jj(cwd: string, args: string[], env: JjEnv): Promise<string> {
  const r = await jjRun(cwd, args, env);
  if (r.code !== 0) {
    const hint = r.stderr.trim() !== "" ? r.stderr.trim() : r.stdout.trim();
    throw new Error(`jj ${args.join(" ")} in ${cwd} failed with exit code ${r.code}: ${hint}`);
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

// jj has no per-repo key/value config like git, so squashed sandboxes are
// tracked in a JSON marker next to the workspaces. A missing or corrupt marker
// reads as empty, which keeps branches alive (merged=false), the safe
// direction for prune.
function readMarker(markerPath: string, logger: Logger): Record<string, string> {
  if (!existsSync(markerPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    const map: Record<string, string> = {};
    if (typeof parsed === "object" && parsed !== null) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") map[key] = value;
      }
    }
    return map;
  } catch (err) {
    logger.error("sandbox", err);
    return {};
  }
}

export class JjSandbox implements SandboxBackend {
  readonly name = "jj";
  private readonly logger: Logger;
  private readonly env: JjEnv;

  // The environment is injectable so tests can isolate the machine's global
  // jj config, following the injected-clock-and-spawner rule for lib modules.
  constructor(logger: Logger, env: JjEnv = process.env) {
    this.logger = logger;
    this.env = env;
  }

  async detect(cwd: string): Promise<{ repoRoot: string } | null> {
    // jj root reports the containing workspace, so detection from inside a
    // sandbox yields that workspace, which is what the caller wants.
    const r = await jjRun(cwd, ["root"], this.env);
    if (r.code !== 0) return null; // not a jj repo, or jj is missing
    const repoRoot = r.stdout.trim();
    return repoRoot === "" ? null : { repoRoot };
  }

  async create(opts: { cwd: string; id: string; base?: string; root?: string }): Promise<Sandbox> {
    const { cwd, id } = opts;
    validateSandboxId(id);
    const branch = `${PREFIX}${id}`;
    const root = opts.root ?? DEFAULT_ROOT;

    // Sandboxes always live under the MAIN workspace, even when cwd is inside
    // a secondary workspace, so the main root is derived from the .jj/repo
    // pointer instead of jj root (which would point at the calling workspace).
    const mainRoot = await this.mainRoot(cwd);
    const path = isAbsolute(root) ? resolve(root, id) : resolve(mainRoot, root, id);

    if (existsSync(path)) {
      throw new Error(`cannot create sandbox ${id}: path ${path} already exists`);
    }
    const bookmarkProbe = await jjRun(mainRoot, ["log", "-r", branch, "--no-graph", "-T", "commit_id"], this.env);
    if (bookmarkProbe.code === 0) {
      throw new Error(`cannot create sandbox ${id}: bookmark ${branch} already exists`);
    }
    // A leftover workspace name without a bookmark surfaces as a plain jj
    // error from workspace add, which is safe here because the name check
    // happens before anything is created.

    // Resolve to a commit id in the MAIN workspace so the default @- means
    // the main working copy's parent, and later diffs stay stable even if a
    // named bookmark moves. git HEAD and @- both mean "the last finished
    // commit", excluding work in progress.
    const baseSpec = opts.base ?? "@-";
    let base = "";
    try {
      const resolved = await jj(mainRoot, ["log", "-r", baseSpec, "--no-graph", "-T", "commit_id"], this.env);
      const first = resolved.trim().split("\n")[0]?.trim() ?? "";
      if (resolved.trim() === "" || resolved.trim().includes("\n")) {
        throw new Error(`revset ${JSON.stringify(baseSpec)} does not resolve to a single commit`);
      }
      base = first;
    } catch (err) {
      throw new Error(`cannot create sandbox ${id}: cannot resolve base ${JSON.stringify(baseSpec)}: ${message(err)}`);
    }

    this.excludeRoot(mainRoot, root);
    mkdirSync(dirname(path), { recursive: true });
    let added = false;
    try {
      await jj(mainRoot, ["workspace", "add", "--name", branch, "-r", base, path], this.env);
      added = true;
      // Run in the new workspace so @ is its working copy, and the bookmark
      // tags exactly that change.
      await jj(path, ["bookmark", "create", branch, "-r", "@"], this.env);
    } catch (err) {
      // A failed add does not prove ownership of the destination: another
      // process may have created it since the initial existence check.
      if (added) await this.cleanupFailedCreate({ id, branch, path, base, repoRoot: mainRoot });
      throw err;
    }
    return { id, branch, path, base, repoRoot: mainRoot };
  }

  async commitAll(sb: Sandbox, msg: string): Promise<{ committed: boolean; sha?: string }> {
    // Any command run in the workspace snapshots the working copy first, so
    // the summary below already reflects the on-disk state. jj has no hooks,
    // so nothing has to be disabled.
    const summary = await this.jjWs(sb.path, ["diff", "-r", "@", "--summary"]);
    if (summary.trim() === "") return { committed: false };
    await this.jjWs(sb.path, ["describe", "-m", msg]);
    // Bookmarks follow commit rewrites on their own; set repairs a bookmark
    // that a user or an older squash moved, and -B covers a sideways move.
    await this.jjWs(sb.path, ["bookmark", "set", "-B", sb.branch, "-r", "@"]);
    const sha = (await this.jjWs(sb.path, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])).trim();
    return { committed: true, sha };
  }

  async diffStat(sb: Sandbox): Promise<string> {
    // One command covers described and undescribed work: @ is rewritten by
    // every snapshot, so it always holds the sandbox's full diff from base.
    const out = await this.jjWs(sb.path, ["diff", "--stat", "--from", sb.base, "--to", "@"]);
    const text = out.trim();
    // jj prints a "0 files changed" summary line for an empty diff.
    return text === "" || text.startsWith("0 files changed") ? "(no changes)" : text;
  }

  async squashInto(targetPath: string, sb: Sandbox, opts: { commit: boolean; message?: string }): Promise<SquashResult> {
    // Snapshot and check the destination before touching the source. Otherwise
    // commit mode would silently include the user's existing working-copy edits.
    const targetChanges = await this.jjWs(targetPath, ["diff", "-r", "@", "--summary"]);
    if (targetChanges.trim() !== "") {
      return {
        ok: false,
        conflicts: [],
        error: `refusing to squash into ${targetPath}: it has uncommitted changes, sandbox work must never be mixed with user work`,
      };
    }
    // One command does two jobs: -R selects the sandbox as the current
    // workspace, so jj snapshots it (capturing work that was never described),
    // and the summary counts the squashed content. Count before the squash:
    // --keep-emptied leaves the source commit but empties it, so the same
    // diff would read zero afterwards.
    const summary = await this.jjWsR(sb.path, targetPath, ["diff", "-r", sb.branch, "--summary"]);
    const filesChanged = lines(summary).length;
    // Squash a duplicate: rewriting the source would move its bookmark even
    // on conflict. Never restore an operation, which can erase concurrent work.
    const source = (await jj(targetPath, ["log", "-r", sb.branch, "--no-graph", "-T", "commit_id"], this.env)).trim();
    const marker = readMarker(join(sb.repoRoot, ".jj", MARKER_NAME), this.logger);
    if (marker[sb.branch] === source) return { ok: true, filesChanged: 0 };
    const duplicate = await jjRun(targetPath, ["--config", 'templates.commit_summary="commit_id"', "duplicate", source], this.env);
    const duplicateId = /\bas ([0-9a-f]{40,64})\s*$/.exec(duplicate.stderr)?.[1];
    if (duplicate.code !== 0 || duplicateId === undefined) {
      return { ok: false, conflicts: [], error: `cannot duplicate sandbox change: ${duplicate.stderr.trim()}` };
    }
    const squash = await jjRun(targetPath, ["squash", "--from", duplicateId, "--into", "@", "--use-destination-message"], this.env);
    if (squash.code !== 0) {
      const hint = squash.stderr.trim() !== "" ? squash.stderr.trim() : squash.stdout.trim();
      return { ok: false, conflicts: [], error: `squash failed with exit code ${squash.code}: ${hint}` };
    }
    const conflicts = await jjRun(targetPath, ["resolve", "--list"], this.env);
    // A conflicted target is left for manual recovery rather than restoring
    // repository-wide state and discarding unrelated concurrent operations.
    if (conflicts.code === 0 && conflicts.stdout.trim() !== "") {
      const paths = lines(conflicts.stdout).map((l) => l.split(/\s+/)[0]);
      return { ok: false, conflicts: paths, error: "squash left conflicts in the target; manual recovery may be required" };
    }
    if (conflicts.code !== 0 && conflicts.code !== 2) {
      return {
        ok: false,
        conflicts: [],
        error: `cannot check squash conflicts; manual recovery may be required: ${conflicts.stderr.trim()}`,
      };
    }
    let commitSha: string | undefined;
    if (opts.commit) {
      await jj(targetPath, ["describe", "-m", opts.message ?? `squash ${sb.branch}`], this.env);
      commitSha = (await jj(targetPath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"], this.env)).trim();
      // Empty the target's working-copy change so the next squash starts clean.
      await jj(targetPath, ["new"], this.env);
    }
    // An uncommitted root squash can be abandoned, so its source is still
    // the only durable backup and must not become eligible for pruning.
    if (opts.commit) this.recordSquashed(sb, source);
    return { ok: true, commitSha, filesChanged };
  }

  async remove(sb: Sandbox, opts: { keepBranch: boolean }): Promise<void> {
    // Absolute roots outside the main workspace are supported; registration
    // and repository-pointer checks below establish ownership before removal.
    const mainRoot = resolve(sb.repoRoot);
    const path = resolve(sb.path);
    validateSandboxId(sb.id);
    if (path === mainRoot || basename(path) !== sb.id) {
      throw new Error(`bug: sandbox path ${path} does not match id ${sb.id}`);
    }
    if (sb.branch !== `${PREFIX}${sb.id}`) throw new Error(`bug: sandbox branch ${sb.branch} does not match ${sb.id}`);
    const registered = (await this.workspaces(mainRoot)).get(sb.branch);
    if (registered !== undefined && resolve(registered) !== path) {
      throw new Error(`refusing to remove sandbox: workspace ${sb.branch} is registered at ${registered}, not ${path}`);
    }
    if (existsSync(path)) {
      if (registered === undefined) throw new Error(`refusing to remove sandbox: workspace ${sb.branch} is not registered`);
      // A registered directory may have been replaced with unrelated user data.
      // Check its repository pointer before forgetting it or deleting anything.
      const pointer = join(path, ".jj", "repo");
      let matches = false;
      try {
        const repo = resolve(dirname(pointer), readFileSync(pointer, "utf8").trim());
        matches = realpathSync(repo) === realpathSync(join(mainRoot, ".jj", "repo"));
      } catch (err) {
        throw new Error(`refusing to remove sandbox: cannot verify workspace ${path}: ${message(err)}`);
      }
      if (!matches) throw new Error(`refusing to remove sandbox: workspace ${path} belongs to another repository`);
    }
    if (registered !== undefined) await jj(mainRoot, ["workspace", "forget", sb.branch], this.env);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    // Colocated repos carry a git worktree per workspace; forget normally
    // removes it, prune covers a forget that failed part way.
    if (existsSync(join(mainRoot, ".git"))) {
      const prune = await gitRun(mainRoot, ["worktree", "prune"], this.env);
      if (prune.code !== 0) {
        this.logger.error("sandbox", new Error(`git worktree prune failed with exit code ${prune.code}: ${prune.stderr.trim()}`));
      }
    }
    if (!opts.keepBranch) {
      await jj(mainRoot, ["bookmark", "delete", sb.branch], this.env);
    }
  }

  async list(repoRoot: string): Promise<SandboxInfo[]> {
    const names = lines(await jj(repoRoot, ["bookmark", "list", `${PREFIX}*`, "-T", 'name ++ "\\n"'], this.env));
    const workspaces = await this.workspaces(repoRoot);
    const marker = readMarker(join(repoRoot, ".jj", MARKER_NAME), this.logger);
    const infos: SandboxInfo[] = [];
    for (const branch of names) {
      // Skip remote bookmarks, which jj lists alongside local ones.
      if (!branch.startsWith(PREFIX) || branch.includes("@")) continue;
      const root = workspaces.get(branch);
      const hasWorktree = root !== undefined && existsSync(root);
      const recorded = marker[branch];
      let merged = false;
      if (recorded !== undefined && /^[0-9a-f]{40,64}$/.test(recorded)) {
        const tip = await jj(repoRoot, ["log", "-r", branch, "--no-graph", "-T", 'commit_id ++ "\\n"'], this.env);
        merged = tip.trim() === recorded;
      }
      infos.push({
        branch,
        id: branch.slice(PREFIX.length),
        path: hasWorktree ? root : undefined,
        merged,
        hasWorktree,
      });
    }
    return infos;
  }

  async pruneMerged(repoRoot: string): Promise<string[]> {
    if ((await this.list(repoRoot)).some((info) => info.merged && !info.hasWorktree)) {
      throw new Error("automatic jj bookmark pruning is disabled; inspect and delete bookmarks manually");
    }
    return [];
  }

  // Runs jj in a sandbox workspace. A squash rewrites the sandbox's
  // working-copy commit from the target's process, which marks the sandbox's
  // working copy stale; refresh it once and retry. update-stale preserves
  // unsnapshotted edits as a divergent change, so nothing is lost.
  private async jjWs(wsPath: string, args: string[]): Promise<string> {
    try {
      return await jj(wsPath, args, this.env);
    } catch (err) {
      if (!message(err).includes("working copy is stale")) throw err;
      await jj(wsPath, ["workspace", "update-stale"], this.env);
      return await jj(wsPath, args, this.env);
    }
  }

  // Same retry, but the workspace is selected with -R from another working
  // directory.
  private async jjWsR(wsPath: string, cwd: string, args: string[]): Promise<string> {
    try {
      return await jj(cwd, ["-R", wsPath, ...args], this.env);
    } catch (err) {
      if (!message(err).includes("working copy is stale")) throw err;
      await jj(cwd, ["-R", wsPath, "workspace", "update-stale"], this.env);
      return await jj(cwd, ["-R", wsPath, ...args], this.env);
    }
  }

  private async mainRoot(cwd: string): Promise<string> {
    const r = await jjRun(cwd, ["root"], this.env);
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() !== "" ? r.stderr.trim() : `${cwd} is not inside a jj repository`);
    }
    const wsRoot = r.stdout.trim();
    // A secondary workspace stores an absolute pointer to the main .jj/repo in
    // a .jj/repo file; the main workspace has a real directory there instead.
    const repoPointer = join(wsRoot, ".jj", "repo");
    let isMain = false;
    try {
      isMain = statSync(repoPointer).isDirectory();
    } catch (err) {
      throw new Error(`cannot locate the repository of workspace ${wsRoot}: ${message(err)}`);
    }
    if (isMain) return wsRoot;
    // The pointer file holds a path relative to the .jj directory (or an
    // absolute one, which resolve handles too).
    const mainRepo = resolve(dirname(repoPointer), readFileSync(repoPointer, "utf8").trim());
    return dirname(dirname(mainRepo));
  }

  private async workspaces(repoRoot: string): Promise<Map<string, string>> {
    const out = await jj(repoRoot, ["workspace", "list", "-T", 'name ++ "\\t" ++ root ++ "\\n"'], this.env);
    const map = new Map<string, string>();
    for (const line of out.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const name = line.slice(0, tab);
      const root = line.slice(tab + 1).trim();
      if (name !== "" && root !== "") map.set(name, root);
    }
    return map;
  }

  // R-S2: keep the sandbox root invisible to plain git in colocated repos. jj
  // itself never snapshots nested workspace directories (each contains .jj),
  // so a non-colocated repo needs no entry, and a line in a tracked .gitignore
  // would dirty the tree. Appended once, so repeated creates do not duplicate.
  private excludeRoot(mainRoot: string, root: string): void {
    if (!existsSync(join(mainRoot, ".git"))) return;
    const line = `${root.replace(/\/+$/, "")}/`;
    const excludePath = join(mainRoot, ".git", "info", "exclude");
    mkdirSync(dirname(excludePath), { recursive: true });
    const content = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (content.split("\n").includes(line)) return;
    const sep = content === "" || content.endsWith("\n") ? "" : "\n";
    writeFileSync(excludePath, `${content}${sep}${line}\n`);
  }

  // jj has no equivalent of git config for the squash marker, so merged
  // sandboxes are recorded next to the repo state in the main .jj directory.
  private recordSquashed(sb: Sandbox, tip: string): void {
    const markerPath = join(sb.repoRoot, ".jj", MARKER_NAME);
    const map = readMarker(markerPath, this.logger);
    map[sb.branch] = tip;
    writeFileSync(markerPath, `${JSON.stringify(map, null, 2)}\n`);
  }

  // Best effort: keep the bookmark, which could belong to a racing process,
  // and use the same ownership checks as normal removal for the directory.
  private async cleanupFailedCreate(sb: Sandbox): Promise<void> {
    try {
      await this.remove(sb, { keepBranch: true });
    } catch (err) {
      this.logger.error("sandbox", err);
    }
  }
}
