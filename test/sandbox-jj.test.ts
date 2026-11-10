// Tests for the jj sandbox backend (SPEC 5.6, backlog B-1). Every test builds
// a real temporary jj repository, isolated from the machine's global jj
// config, and removes it when done. Flow-heavy tests use non-colocated repos
// (jj creates a git worktree per colocated workspace, which dominates the
// runtime); the colocated-only paths (git exclude, worktree pruning) have
// dedicated colocated tests.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { JjSandbox } from "../extensions/lib/sandbox-jj.ts";
import { validateSandboxId } from "../extensions/lib/sandbox.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { hasJj } from "./helpers.ts";

const exec = promisify(execFile);

type TestEnv = Record<string, string | undefined>;

function tempDir(t: { after(fn: () => void): void }): string {
  // realpath because jj reports the resolved path (/private/var instead of
  // /var on macOS), and tests compare jj output with the dir they created.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-inf-sbx-jj-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function xjj(cwd: string, env: TestEnv, args: string[]): Promise<string> {
  const r = await exec("jj", ["--no-pager", "--color=never", ...args], { cwd, env, encoding: "utf8" });
  return r.stdout;
}

function xgit(cwd: string, env: TestEnv, args: string[]): Promise<string> {
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  return exec("git", args, { cwd, env: gitEnv, encoding: "utf8" }).then((r) => r.stdout);
}

// Each repo gets an empty config file so results do not depend on the user's
// global jj config, and JJ_USER/JJ_EMAIL give every operation an identity.
async function initRepo(t: { after(fn: () => void): void }, opts: { colocate?: boolean } = {}): Promise<{ repo: string; env: TestEnv }> {
  const repo = tempDir(t);
  const cfgDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-inf-sbx-jjcfg-")));
  t.after(() => rmSync(cfgDir, { recursive: true, force: true }));
  writeFileSync(join(cfgDir, "jj.toml"), "");
  const env: TestEnv = {
    ...process.env,
    JJ_CONFIG: join(cfgDir, "jj.toml"),
    JJ_USER: "Test User",
    JJ_EMAIL: "test@example.invalid",
  };
  await xjj(repo, env, ["git", "init", opts.colocate === false ? "--no-colocate" : "--colocate"]);
  // Leave the main working copy empty on top of a described base commit: the
  // state a jj user is normally in, and the state where @- is the base create
  // picks (the analog of git's HEAD).
  writeFileSync(join(repo, "file.txt"), "base\n");
  await xjj(repo, env, ["commit", "-m", "initial commit"]);
  return { repo, env };
}

function backend(env: TestEnv): JjSandbox {
  return new JjSandbox(memoryLogger(), env);
}

// The commit id of a single revision, the machine-readable form tests compare.
async function commitId(cwd: string, env: TestEnv, revset: string): Promise<string> {
  return (await xjj(cwd, env, ["log", "-r", revset, "--no-graph", "-T", "commit_id"])).trim();
}

// The working-copy change's file summary, empty when @ has no changes.
async function summary(cwd: string, env: TestEnv): Promise<string> {
  return (await xjj(cwd, env, ["diff", "-r", "@", "--summary"])).trim();
}

// Subtests run in parallel: each builds its own throwaway repo in a private
// temp dir, so they cannot interfere, and the file stays fast.
test("jj sandbox backend", { concurrency: 8, skip: hasJj ? false : "jj is not installed" }, (t) => {
  t.test("R-S1 create builds isolated workspaces that never touch the main working copy", async (t) => {
    const { repo, env } = await initRepo(t);
    const atBefore = await commitId(repo, env, "@");
    const b = backend(env);
    const s1 = await b.create({ cwd: repo, id: "alpha" });
    const s2 = await b.create({ cwd: repo, id: "beta" });
    assert.equal(s1.branch, "sandbox-alpha");
    assert.equal(s1.path, join(repo, ".pi", "sandboxes", "alpha"));
    assert.equal(s1.repoRoot, repo);
    assert.equal(s1.base, await commitId(repo, env, "@-"));
    // The sandboxes start from the base content, not from an empty tree.
    assert.equal(readFileSync(join(s1.path, "file.txt"), "utf8"), "base\n");
    writeFileSync(join(s1.path, "file.txt"), "changed by alpha\n");
    writeFileSync(join(s2.path, "other.txt"), "changed by beta\n");
    assert.equal(readFileSync(join(s2.path, "file.txt"), "utf8"), "base\n");
    assert.equal(existsSync(join(s1.path, "other.txt")), false);
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");
    // R-S8: sandbox work never rewrites the main working-copy commits.
    writeFileSync(join(s1.path, "new.txt"), "more work\n");
    await b.commitAll(s1, "thread alpha");
    assert.equal(await commitId(repo, env, "@"), atBefore);
    assert.equal(await commitId(repo, env, "@-"), s1.base);
    assert.equal(await summary(repo, env), "");
    // R-S2: the sandbox root is excluded once and plain git stays clean; jj
    // itself never snapshots nested workspaces.
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((l) => l === ".pi/sandboxes/").length, 1);
    assert.equal((await xgit(repo, env, ["status", "--porcelain"])).trim(), "");
  });

  t.test("R-S4 R-S5 stale workspace commands refresh once, including with -R", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const original = backend(env);
    const sb = await original.create({ cwd: repo, id: "stale" });
    writeFileSync(join(sb.path, "work.txt"), "work\n");
    await original.commitAll(sb, "work");
    const bin = tempDir(t);
    const realJj = (await exec("which", ["jj"], { env, encoding: "utf8" })).stdout.trim();
    const marker = join(bin, "triggered");
    const log = join(bin, "calls");
    writeFileSync(
      join(bin, "jj"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$JJ_TEST_LOG"
case "$JJ_TEST_MODE:$*" in
  fail:*"diff --stat"*) echo 'permission denied' >&2; exit 1;;
  stuck:*"diff --stat"*|refresh:*"diff --stat"*) echo 'working copy is stale' >&2; exit 1;;
  refresh:*"workspace update-stale"*) echo 'refresh failed' >&2; exit 1;;
esac
case "$*" in *"workspace update-stale"*) exit 0;; esac
if [ ! -e "$JJ_TEST_MARKER" ]; then
  case "$JJ_TEST_MODE:$*" in
    local:*"diff --stat"*|remote:*" -R "*)
      : > "$JJ_TEST_MARKER"
      printf '%s\\n' 'working copy is stale' >&2
      exit 1;;
  esac
fi
exec "$JJ_TEST_REAL" "$@"
`,
    );
    chmodSync(join(bin, "jj"), 0o755);
    const wrapped = (mode: string) =>
      backend({ ...env, PATH: `${bin}:${env.PATH}`, JJ_TEST_REAL: realJj, JJ_TEST_LOG: log, JJ_TEST_MARKER: marker, JJ_TEST_MODE: mode });
    assert.match(await wrapped("local").diffStat(sb), /work\.txt/);
    let calls = readFileSync(log, "utf8");
    assert.equal(calls.split("\n").filter((line) => line.includes("workspace update-stale")).length, 1);
    rmSync(marker);
    writeFileSync(log, "");
    assert.equal((await wrapped("remote").squashInto(repo, sb, { commit: false })).ok, true);
    calls = readFileSync(log, "utf8");
    assert.equal(calls.split("\n").filter((line) => line.includes("workspace update-stale") && line.includes(`-R ${sb.path}`)).length, 1);
    for (const [mode, error, attempts, refreshes] of [
      ["fail", /permission denied/, 1, 0],
      ["stuck", /working copy is stale/, 2, 1],
      ["refresh", /refresh failed/, 1, 1],
    ] as const) {
      writeFileSync(log, "");
      await assert.rejects(wrapped(mode).diffStat(sb), error);
      calls = readFileSync(log, "utf8");
      assert.equal(calls.split("\n").filter((line) => line.includes("diff --stat")).length, attempts);
      assert.equal(calls.split("\n").filter((line) => line.includes("workspace update-stale")).length, refreshes);
    }
  });

  t.test("R-S7 removal preserves unsnapshotted and ignored files", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "preserve" });
    writeFileSync(join(sb.path, "new.txt"), "unsnapshotted");
    await assert.rejects(b.remove(sb, { keepBranch: true }), /unsnapshotted/);
    assert.equal(readFileSync(join(sb.path, "new.txt"), "utf8"), "unsnapshotted");
    writeFileSync(join(sb.path, ".gitignore"), "ignored.txt\n");
    await b.commitAll(sb, "snapshot");
    writeFileSync(join(sb.path, "ignored.txt"), "ignored");
    await assert.rejects(b.remove(sb, { keepBranch: true }), /ignored/);
    assert.equal(readFileSync(join(sb.path, "ignored.txt"), "utf8"), "ignored");
  });

  t.test("R-S7 removal keeps a workspace whose bookmark moved away", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "moved" });
    writeFileSync(join(sb.path, "work.txt"), "valuable");
    await b.commitAll(sb, "work");
    await xjj(repo, env, ["bookmark", "set", "-B", sb.branch, "-r", `${sb.branch}-`]);
    await assert.rejects(b.remove(sb, { keepBranch: true }), /bookmark.*does not point/);
    assert.equal(readFileSync(join(sb.path, "work.txt"), "utf8"), "valuable");
  });

  t.test("R-S5 squash marker does not suppress squash into another target", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const source = await b.create({ cwd: repo, id: "source" });
    const target = await b.create({ cwd: repo, id: "target" });
    writeFileSync(join(source.path, "new.txt"), "source content");
    assert.equal((await b.squashInto(repo, source, { commit: true })).ok, true);
    const second = await b.squashInto(target.path, source, { commit: true });
    assert.equal(second.ok, true);
    assert.equal(readFileSync(join(target.path, "new.txt"), "utf8"), "source content");
  });

  t.test("R-S1 validateSandboxId rejects traversal and malformed ids", async () => {
    const bad = ["", "..", ".", "../escape", "a/b", "a\\b", "a b", "-lead", "_lead", "x".repeat(42)];
    for (const id of bad) assert.throws(() => validateSandboxId(id), Error, `id ${JSON.stringify(id)}`);
    const good = ["a", "A-b_9", "9", "x".repeat(41)];
    for (const id of good) assert.doesNotThrow(() => validateSandboxId(id));
    // create rejects the id before touching jj at all.
    const b = new JjSandbox(memoryLogger());
    await assert.rejects(b.create({ cwd: "/", id: "../escape" }), /invalid sandbox id/);
  });

  t.test("R-S1 create fails outside a jj repository", async (t) => {
    const dir = tempDir(t);
    const b = backend({ ...process.env, JJ_CONFIG: "/dev/null", JJ_USER: "t", JJ_EMAIL: "t@invalid" });
    assert.equal(await b.detect(dir), null);
    await assert.rejects(b.create({ cwd: dir, id: "nowhere" }), /no jj repo/);
  });

  t.test("R-S1 create refuses an id whose bookmark, workspace or path already exists", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "dup" });
    await assert.rejects(b.create({ cwd: repo, id: "dup" }), /already exists/);
    mkdirSync(join(repo, ".pi", "sandboxes", "occupied"), { recursive: true });
    await assert.rejects(b.create({ cwd: repo, id: "occupied" }), /already exists/);
    // Free the path and the bookmark, but the forgotten workspace name remains.
    await xjj(repo, env, ["bookmark", "delete", "sandbox-dup"]);
    rmSync(sb.path, { recursive: true, force: true });
    await assert.rejects(b.create({ cwd: repo, id: "dup" }), /already exists/);
    await assert.rejects(b.create({ cwd: repo, id: "orphan", base: "does-not-exist" }), /cannot resolve base/);
  });

  t.test("R-S2 a non-colocated repo needs no exclude and the full flow works", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    assert.equal(existsSync(join(repo, ".git")), false);
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "solo" });
    writeFileSync(join(sb.path, "file.txt"), "from sandbox\n");
    await b.commitAll(sb, "thread solo");
    // jj ignores nested workspaces, so the main change stays empty without any
    // exclude entry.
    assert.equal(await summary(repo, env), "");
    const res = await b.squashInto(repo, sb, { commit: true });
    if (!res.ok) {
      assert.fail(`expected squash to succeed: ${res.error}`);
    } else {
      assert.equal(res.filesChanged, 1);
      assert.match(res.commitSha ?? "", /^[0-9a-f]{40}$/);
    }
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "from sandbox\n");
    // No .git/info/exclude appears because there is no colocated git repo.
    assert.equal(existsSync(join(repo, ".git", "info", "exclude")), false);
  });

  t.test("R-S3 commitAll skips an empty change, R-S4 diffStat covers all work", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "alpha" });
    assert.deepEqual(await b.commitAll(sb, "nothing to do"), { committed: false });
    assert.equal(await b.diffStat(sb), "(no changes)");
    writeFileSync(join(sb.path, "new.txt"), "data\n");
    assert.match(await b.diffStat(sb), /new\.txt/);
    const res = await b.commitAll(sb, "thread alpha");
    assert.equal(res.committed, true);
    assert.match(res.sha ?? "", /^[0-9a-f]{40}$/);
    assert.equal((await xjj(sb.path, env, ["log", "-r", "@", "--no-graph", "-T", "description"])).trim(), "thread alpha");
    // The bookmark follows the working-copy change.
    assert.equal(await commitId(sb.path, env, "sandbox-alpha"), await commitId(sb.path, env, "@"));
    // In jj a described change keeps its content in @, so a second call does
    // not see an empty change; re-describing with the same message is a no-op
    // and returns the same commit id.
    const again = await b.commitAll(sb, "thread alpha");
    assert.equal(again.committed, true);
    assert.equal(again.sha, res.sha);
    // An undescribed edit must still show up against the base.
    writeFileSync(join(sb.path, "new.txt"), "edited again\n");
    assert.match(await b.diffStat(sb), /new\.txt/);
  });

  t.test("R-S5 squash into a sandbox workspace commits the result", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const parent = await b.create({ cwd: repo, id: "parent" });
    const child = await b.create({ cwd: repo, id: "child", base: parent.branch });
    assert.equal(child.base, await commitId(repo, env, parent.branch));
    writeFileSync(join(child.path, "feature.txt"), "from child\n");
    await b.commitAll(child, "thread child");
    const res = await b.squashInto(parent.path, child, { commit: true });
    if (!res.ok) {
      assert.fail(`expected squash to succeed: ${res.error}`);
    } else {
      assert.equal(res.filesChanged, 1);
      assert.match(res.commitSha ?? "", /^[0-9a-f]{40}$/);
    }
    assert.equal(readFileSync(join(parent.path, "feature.txt"), "utf8"), "from child\n");
    // The squashed change is described and the target working copy is empty again.
    const desc = (await xjj(parent.path, env, ["log", "-r", "@-", "--no-graph", "-T", "description"])).trim();
    assert.equal(desc, "squash sandbox-child");
    assert.equal(await commitId(parent.path, env, "@-"), res.ok ? res.commitSha : "");
    assert.equal(await summary(parent.path, env), "");
    // The child's own workspace is untouched and still usable.
    assert.equal(readFileSync(join(child.path, "feature.txt"), "utf8"), "from child\n");
  });

  t.test("R-S5 squash into the main checkout without commit leaves changes in the working copy", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "feature" });
    writeFileSync(join(sb.path, "file.txt"), "from sandbox\n");
    await b.commitAll(sb, "thread feature");
    const res = await b.squashInto(repo, sb, { commit: false });
    if (!res.ok) {
      assert.fail(`expected squash to succeed: ${res.error}`);
    } else {
      assert.equal(res.filesChanged, 1);
      assert.equal(res.commitSha, undefined);
    }
    // The change sits in the main working-copy change, undescribed.
    assert.equal(await summary(repo, env), "M file.txt");
    assert.equal((await xjj(repo, env, ["log", "-r", "@", "--no-graph", "-T", "description"])).trim(), "");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "from sandbox\n");
  });

  t.test("R-S5 squash refuses existing target changes without altering either workspace", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "dirty-target" });
    writeFileSync(join(sb.path, "sandbox.txt"), "sandbox work\n");
    await b.commitAll(sb, "sandbox work");
    const sourceBefore = await commitId(repo, env, sb.branch);
    writeFileSync(join(repo, "user.txt"), "user work\n");
    for (const commit of [false, true]) {
      const result = await b.squashInto(repo, sb, { commit });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error ?? "", /uncommitted changes/);
      assert.equal(readFileSync(join(repo, "user.txt"), "utf8"), "user work\n");
      assert.equal(existsSync(join(repo, "sandbox.txt")), false);
      assert.equal(await commitId(repo, env, sb.branch), sourceBefore);
      assert.equal(readFileSync(join(sb.path, "sandbox.txt"), "utf8"), "sandbox work\n");
    }
  });

  t.test("R-S5 a second child and a no-op squash behave", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const c1 = await b.create({ cwd: repo, id: "first" });
    const c2 = await b.create({ cwd: repo, id: "second" });
    writeFileSync(join(c1.path, "one.txt"), "one\n");
    await b.commitAll(c1, "thread first");
    writeFileSync(join(c2.path, "two.txt"), "two\n");
    await b.commitAll(c2, "thread second");
    const r1 = await b.squashInto(repo, c1, { commit: true, message: "take first" });
    assert.equal(r1.ok, true);
    const r2 = await b.squashInto(repo, c2, { commit: true, message: "take second" });
    assert.equal(r2.ok, true);
    assert.equal(readFileSync(join(repo, "one.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(repo, "two.txt"), "utf8"), "two\n");
    // --keep-emptied emptied c2's change, so squashing it again is a no-op that
    // returns zero files instead of refusing.
    const res = await b.squashInto(repo, c2, { commit: true });
    if (!res.ok) {
      assert.fail(`expected squash to succeed: ${res.error}`);
    } else {
      assert.equal(res.filesChanged, 0);
    }
  });

  t.test("R-S6 conflicts abort the squash and leave the target and sandbox bookmark intact", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const c1 = await b.create({ cwd: repo, id: "first" });
    const c2 = await b.create({ cwd: repo, id: "second" });
    writeFileSync(join(c1.path, "file.txt"), "one\n");
    await b.commitAll(c1, "thread first");
    writeFileSync(join(c2.path, "file.txt"), "two\n");
    await b.commitAll(c2, "thread second");
    const secondAt = await commitId(repo, env, "sandbox-second");
    const r1 = await b.squashInto(repo, c1, { commit: true });
    assert.equal(r1.ok, true);
    const res = await b.squashInto(repo, c2, { commit: true });
    if (res.ok) {
      assert.fail("expected the second squash to conflict");
    } else {
      assert.deepEqual(res.conflicts, ["file.txt"]);
    }
    // Conflict recovery is manual; the source remains available as a backup.
    assert.match(res.error ?? "", /manual recovery/);
    assert.match(await xjj(repo, env, ["resolve", "--list"]), /file\.txt/);
    // The second sandbox and its bookmark are untouched.
    assert.equal(readFileSync(join(c2.path, "file.txt"), "utf8"), "two\n");
    assert.equal(await commitId(repo, env, "sandbox-second"), secondAt);
  });

  t.test("R-S6 conflicting squash does not restore over concurrent operations", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const first = await b.create({ cwd: repo, id: "first" });
    const second = await b.create({ cwd: repo, id: "second" });
    writeFileSync(join(first.path, "file.txt"), "one\n");
    writeFileSync(join(second.path, "file.txt"), "two\n");
    await b.commitAll(first, "first");
    await b.commitAll(second, "second");
    assert.equal((await b.squashInto(repo, first, { commit: true })).ok, true);
    const source = await commitId(repo, env, second.branch);
    const bin = tempDir(t);
    const realJj = (await exec("which", ["jj"], { env, encoding: "utf8" })).stdout.trim();
    const wrapper = join(bin, "jj");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase "$*" in\n  *"resolve --list"*) "${realJj}" --ignore-working-copy bookmark create unrelated -r @- || exit $?;;\nesac\nexec "${realJj}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const result = await backend({ ...env, PATH: `${bin}:${env.PATH}` }).squashInto(repo, second, { commit: true });
    assert.equal(result.ok, false);
    assert.equal(await commitId(repo, env, second.branch), source);
    assert.match(await commitId(repo, env, "unrelated"), /^[0-9a-f]{40}$/);
  });

  t.test("R-S7 uncommitted root squash keeps its source bookmark through prune", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "backup" });
    writeFileSync(join(sb.path, "work.txt"), "valuable\n");
    await b.commitAll(sb, "work");
    const source = await commitId(repo, env, sb.branch);
    assert.equal((await b.squashInto(repo, sb, { commit: false })).ok, true);
    await b.remove(sb, { keepBranch: true });
    assert.deepEqual(await b.pruneMerged(repo), []);
    await xjj(repo, env, ["abandon", "@"]);
    assert.equal(await commitId(repo, env, sb.branch), source);
    assert.equal((await xjj(repo, env, ["file", "show", "-r", sb.branch, "work.txt"])).trim(), "valuable");
  });

  t.test("R-S7 remove deletes the workspace and optionally the bookmark", async (t) => {
    const { repo, env } = await initRepo(t);
    const b = backend(env);
    const keep = await b.create({ cwd: repo, id: "keep" });
    const gone = await b.create({ cwd: repo, id: "gone" });
    const keepAt = await commitId(repo, env, "sandbox-keep");
    await b.remove(keep, { keepBranch: true });
    assert.equal(existsSync(keep.path), false);
    // The kept bookmark still points at the sandbox's last change.
    assert.equal(await commitId(repo, env, "sandbox-keep"), keepAt);
    await b.remove(gone, { keepBranch: false });
    assert.equal(existsSync(gone.path), false);
    await assert.rejects(xjj(repo, env, ["log", "-r", "sandbox-gone", "--no-graph"]));
    const names = (await xjj(repo, env, ["workspace", "list", "-T", 'name ++ "\n"'])).trim();
    assert.equal(names.includes("sandbox-keep"), false);
    assert.equal(names.includes("sandbox-gone"), false);
    // jj removes the git worktree on forget; prune covers a partial failure.
    const worktrees = await xgit(repo, env, ["worktree", "list"]);
    assert.equal(worktrees.includes("sandbox-keep"), false);
    assert.equal(worktrees.includes("sandbox-gone"), false);
    // remove refuses to delete a path outside the sandbox root.
    await assert.rejects(b.remove({ ...gone, path: join(repo, "file.txt") }, { keepBranch: true }), /bug:/);
  });

  t.test("R-S7 removal supports an absolute sandbox root outside the repository", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const root = tempDir(t);
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "external", root });
    assert.equal(sb.path, join(root, "external"));
    writeFileSync(join(sb.path, "work.txt"), "work\n");
    await b.commitAll(sb, "work");
    await b.remove(sb, { keepBranch: true });
    assert.equal(existsSync(sb.path), false);
    assert.equal((await xjj(repo, env, ["workspace", "list"])).includes(sb.branch), false);
    assert.match(await commitId(repo, env, sb.branch), /^[0-9a-f]{40}$/);
  });

  t.test("R-S7 failed workspace creation never removes a concurrently created directory", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const bin = tempDir(t);
    const realJj = (await exec("which", ["jj"], { env, encoding: "utf8" })).stdout.trim();
    const wrapper = join(bin, "jj");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase "$*" in\n  *"workspace add"*)\n    for path do :; done\n    mkdir -p "$path"\n    printf 'valuable\\n' > "$path/valuable.txt"\n    exit 1;;\nesac\nexec "${realJj}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const b = backend({ ...env, PATH: `${bin}:${env.PATH}` });
    await assert.rejects(b.create({ cwd: repo, id: "raced" }), /failed with exit code/);
    assert.equal(readFileSync(join(repo, ".pi", "sandboxes", "raced", "valuable.txt"), "utf8"), "valuable\n");
  });

  t.test("R-S7 failed bookmark creation cleans up the owned workspace", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const bin = tempDir(t);
    const realJj = (await exec("which", ["jj"], { env, encoding: "utf8" })).stdout.trim();
    const wrapper = join(bin, "jj");
    writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in\n  *"bookmark create"*) exit 1;;\nesac\nexec "${realJj}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const b = backend({ ...env, PATH: `${bin}:${env.PATH}` });
    await assert.rejects(b.create({ cwd: repo, id: "failed-bookmark" }), /failed with exit code/);
    assert.equal(existsSync(join(repo, ".pi", "sandboxes", "failed-bookmark")), false);
    assert.doesNotMatch(await xjj(repo, env, ["workspace", "list"]), /sandbox-failed-bookmark/);
  });

  t.test("R-S7 removal refuses unrelated and replaced directories without forgetting the workspace", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "safe" });
    const other = join(repo, "other", sb.id);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "valuable.txt"), "keep\n");
    await assert.rejects(b.remove({ ...sb, path: other }, { keepBranch: true }), /registered at/);
    assert.equal(readFileSync(join(other, "valuable.txt"), "utf8"), "keep\n");
    assert.match(await xjj(repo, env, ["workspace", "list"]), /sandbox-safe/);

    rmSync(sb.path, { recursive: true, force: true });
    mkdirSync(sb.path, { recursive: true });
    writeFileSync(join(sb.path, "valuable.txt"), "keep too\n");
    await assert.rejects(b.remove(sb, { keepBranch: true }), /cannot verify workspace/);
    assert.equal(readFileSync(join(sb.path, "valuable.txt"), "utf8"), "keep too\n");
    assert.match(await xjj(repo, env, ["workspace", "list"]), /sandbox-safe/);

    await xjj(repo, env, ["workspace", "forget", sb.branch]);
    await assert.rejects(b.remove(sb, { keepBranch: true }), /not registered/);
    assert.equal(readFileSync(join(sb.path, "valuable.txt"), "utf8"), "keep too\n");
  });

  t.test("R-S7 list reports bookmarks, workspaces and merged state", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const mergedSb = await b.create({ cwd: repo, id: "mergedone" });
    const openSb = await b.create({ cwd: repo, id: "openone" });
    await b.create({ cwd: repo, id: "untouched" });
    writeFileSync(join(mergedSb.path, "m.txt"), "m\n");
    await b.commitAll(mergedSb, "thread mergedone");
    writeFileSync(join(openSb.path, "o.txt"), "o\n");
    await b.commitAll(openSb, "thread openone");
    const r = await b.squashInto(repo, mergedSb, { commit: true });
    assert.equal(r.ok, true);
    await b.remove(openSb, { keepBranch: true });

    const infos = await b.list(repo);
    assert.deepEqual(infos.map((i) => i.id).sort(), ["mergedone", "openone", "untouched"]);
    const byId = new Map(infos.map((i) => [i.id, i]));
    const merged = byId.get("mergedone");
    assert.equal(merged?.merged, true);
    assert.equal(merged?.hasWorktree, true);
    assert.equal(merged?.path, mergedSb.path);
    const open = byId.get("openone");
    assert.equal(open?.merged, false);
    assert.equal(open?.hasWorktree, false);
    assert.equal(open?.path, undefined);
    // jj has no ancestor rule: only the marker decides merged state.
    assert.equal(byId.get("untouched")?.merged, false);
    assert.equal(byId.get("untouched")?.hasWorktree, true);
  });

  t.test("R-S7 moved jj bookmarks and legacy markers cannot be pruned", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const sb = await b.create({ cwd: repo, id: "moved" });
    writeFileSync(join(sb.path, "work.txt"), "work\n");
    await b.commitAll(sb, "work");
    assert.equal((await b.squashInto(repo, sb, { commit: true })).ok, true);
    await b.remove(sb, { keepBranch: true });
    assert.equal((await b.list(repo))[0]?.merged, true);
    await xjj(repo, env, ["bookmark", "set", "-B", sb.branch, "-r", "@"]);
    assert.equal((await b.list(repo))[0]?.merged, false);
    assert.deepEqual(await b.pruneMerged(repo), []);
    writeFileSync(join(repo, ".jj", "pi-infinity-squashed.json"), JSON.stringify({ [sb.branch]: repo }));
    assert.equal((await b.list(repo))[0]?.merged, false);
    assert.deepEqual(await b.pruneMerged(repo), []);
  });

  t.test("R-S7 pruneMerged refuses to delete jj bookmarks", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const a = await b.create({ cwd: repo, id: "a" });
    const c = await b.create({ cwd: repo, id: "c" });
    const kept = await b.create({ cwd: repo, id: "b" });
    for (const [sb, name] of [
      [a, "a.txt"],
      [c, "c.txt"],
    ] as const) {
      writeFileSync(join(sb.path, name), `${name}\n`);
      await b.commitAll(sb, `thread ${sb.id}`);
      const r = await b.squashInto(repo, sb, { commit: true });
      assert.equal(r.ok, true);
    }
    await b.remove(a, { keepBranch: true });
    await assert.rejects(b.pruneMerged(repo), /automatic jj bookmark pruning is disabled/);
    await b.remove(c, { keepBranch: true });
    await assert.rejects(b.pruneMerged(repo), /automatic jj bookmark pruning is disabled/);
    const names = (await xjj(repo, env, ["bookmark", "list", "-T", 'name ++ "\n"'])).trim();
    assert.equal(names.includes("sandbox-a"), true);
    assert.equal(names.includes("sandbox-c"), true);
    assert.equal(names.includes(kept.branch), true);
  });

  t.test("R-S1 a sandbox created from inside a sandbox lives under the main root", async (t) => {
    const { repo, env } = await initRepo(t, { colocate: false });
    const b = backend(env);
    const parent = await b.create({ cwd: repo, id: "parent" });
    // detect from inside a workspace reports that workspace, not the main root.
    const detected = await b.detect(parent.path);
    assert.equal(detected?.repoRoot, parent.path);
    const child = await b.create({ cwd: parent.path, id: "nested", base: parent.branch });
    assert.equal(child.repoRoot, repo);
    assert.equal(child.path, join(repo, ".pi", "sandboxes", "nested"));
    assert.equal(child.base, await commitId(repo, env, parent.branch));
    writeFileSync(join(child.path, "nested.txt"), "from child\n");
    assert.equal(existsSync(join(parent.path, "nested.txt")), false);
  });
});
