// Tests for the jj sandbox backend (SPEC 5.6, backlog B-1). Every test builds
// a real temporary jj repository, isolated from the machine's global jj
// config, and removes it when done. Flow-heavy tests use non-colocated repos
// (jj creates a git worktree per colocated workspace, which dominates the
// runtime); the colocated-only paths (git exclude, worktree pruning) have
// dedicated colocated tests.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    // The target is rolled back: clean working copy at the first child's version.
    assert.equal(await summary(repo, env), "");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "one\n");
    // The second sandbox and its bookmark are untouched.
    assert.equal(readFileSync(join(c2.path, "file.txt"), "utf8"), "two\n");
    assert.equal(await commitId(repo, env, "sandbox-second"), secondAt);
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

  t.test("R-S7 pruneMerged deletes merged bookmarks without a workspace", async (t) => {
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
    // c is merged but still has a workspace, b is not merged: both survive.
    const deleted = await b.pruneMerged(repo);
    assert.deepEqual(deleted, ["sandbox-a"]);
    let names = (await xjj(repo, env, ["bookmark", "list", "-T", 'name ++ "\n"'])).trim();
    assert.equal(names.includes("sandbox-a"), false);
    assert.equal(names.includes("sandbox-c"), true);
    assert.equal(names.includes(kept.branch), true);
    await b.remove(c, { keepBranch: true });
    assert.deepEqual(await b.pruneMerged(repo), ["sandbox-c"]);
    names = (await xjj(repo, env, ["bookmark", "list", "-T", 'name ++ "\n"'])).trim();
    assert.equal(names.includes("sandbox-c"), false);
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
