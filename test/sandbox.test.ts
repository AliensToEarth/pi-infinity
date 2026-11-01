// Tests for the git sandbox backend (SPEC 5.6). Every test builds a real
// temporary git repository, isolated from the machine's global and system git
// config, and removes it when done.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { GitSandbox, validateSandboxId } from "../extensions/lib/sandbox.ts";
import { memoryLogger } from "../extensions/lib/log.ts";

const exec = promisify(execFile);

// GIT_CONFIG_GLOBAL/SYSTEM point at /dev/null so results do not depend on the
// machine running the tests. Each repo sets its own identity explicitly.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function xgit(cwd: string, args: string[]): Promise<string> {
  const r = await exec("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return r.stdout;
}

function tempDir(t: { after(fn: () => void): void }): string {
  // realpath because git reports the resolved path (/private/var instead of /var
  // on macOS), and tests compare git output with the dir they created.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-inf-sbx-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function initRepo(t: { after(fn: () => void): void }, opts: { identity?: boolean } = {}): Promise<string> {
  const dir = tempDir(t);
  await xgit(dir, ["init", "-b", "main"]);
  if (opts.identity !== false) {
    await xgit(dir, ["config", "user.name", "Test User"]);
    await xgit(dir, ["config", "user.email", "test@example.invalid"]);
  }
  return dir;
}

// The initial commit always carries an explicit identity so the helper works in
// repos that intentionally have none configured.
async function commitFile(cwd: string, name: string, content: string, message: string): Promise<void> {
  writeFileSync(join(cwd, name), content);
  await xgit(cwd, ["add", "-A"]);
  await xgit(cwd, ["-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-m", message]);
}

function backend(): GitSandbox {
  return new GitSandbox(memoryLogger());
}

test("R-S1 create builds an isolated worktree on a sandbox branch", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const s1 = await b.create({ cwd: repo, id: "alpha" });
  const s2 = await b.create({ cwd: repo, id: "beta" });
  assert.equal(s1.branch, "sandbox-alpha");
  assert.equal(s1.path, join(repo, ".pi", "sandboxes", "alpha"));
  assert.equal(s1.repoRoot, repo);
  assert.equal(s1.base, (await xgit(repo, ["rev-parse", "HEAD"])).trim());
  writeFileSync(join(s1.path, "file.txt"), "changed by alpha\n");
  writeFileSync(join(s2.path, "other.txt"), "changed by beta\n");
  assert.equal(readFileSync(join(s2.path, "file.txt"), "utf8"), "base\n");
  assert.equal(existsSync(join(s1.path, "other.txt")), false);
  assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");
});

test("R-S1 validateSandboxId rejects traversal and malformed ids", () => {
  const bad = ["", "..", ".", "../escape", "a/b", "a\\b", "a b", "-lead", "_lead", "x".repeat(42)];
  for (const id of bad) assert.throws(() => validateSandboxId(id), Error, `id ${JSON.stringify(id)}`);
  const good = ["a", "A-b_9", "9", "x".repeat(41)];
  for (const id of good) assert.doesNotThrow(() => validateSandboxId(id));
});

test("R-S1 create fails outside a git repository", async (t) => {
  const dir = tempDir(t);
  const b = backend();
  assert.equal(await b.detect(dir), null);
  await assert.rejects(b.create({ cwd: dir, id: "nowhere" }), /not a git repository/);
});

test("R-S1 create fails with a clear error when the repository has no commits", async (t) => {
  const repo = await initRepo(t);
  const b = backend();
  await assert.rejects(b.create({ cwd: repo, id: "empty" }), /no commits/);
});

test("R-S1 create refuses an id whose branch or path already exists", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  await b.create({ cwd: repo, id: "dup" });
  await assert.rejects(b.create({ cwd: repo, id: "dup" }), /already exists/);
  mkdirSync(join(repo, ".pi", "sandboxes", "occupied"), { recursive: true });
  await assert.rejects(b.create({ cwd: repo, id: "occupied" }), /already exists/);
});

test("R-S2 the sandbox root is excluded once even after repeated creates", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  await b.create({ cwd: repo, id: "one" });
  await b.create({ cwd: repo, id: "two" });
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === ".pi/sandboxes/").length, 1);
  assert.equal((await xgit(repo, ["status", "--porcelain"])).trim(), "");
});

test("R-S3 commitAll skips a clean tree and commits a dirty one", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "alpha" });
  assert.deepEqual(await b.commitAll(sb, "nothing to do"), { committed: false });
  writeFileSync(join(sb.path, "new.txt"), "data\n");
  const res = await b.commitAll(sb, "thread alpha");
  assert.equal(res.committed, true);
  assert.match(res.sha ?? "", /^[0-9a-f]{40}$/);
  assert.equal((await xgit(sb.path, ["rev-parse", "HEAD"])).trim(), res.sha);
  assert.equal((await xgit(sb.path, ["log", "-1", "--format=%s"])).trim(), "thread alpha");
  assert.deepEqual(await b.commitAll(sb, "still clean"), { committed: false });
});

test("R-S3 commitAll is not blocked by a failing pre-commit hook", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const hooks = join(repo, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  await xgit(repo, ["config", "core.hooksPath", hooks]);
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "hooked" });
  writeFileSync(join(sb.path, "new.txt"), "data\n");
  const res = await b.commitAll(sb, "thread hooked");
  assert.equal(res.committed, true);
});

test("R-S3 commitAll supplies an identity when the repository has none", async (t) => {
  const repo = await initRepo(t, { identity: false });
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  // Isolated env so the machine's global git identity cannot answer the
  // identity probe and the fallback path is really exercised.
  const b = new GitSandbox(memoryLogger(), GIT_ENV);
  const sb = await b.create({ cwd: repo, id: "anon" });
  writeFileSync(join(sb.path, "new.txt"), "data\n");
  const res = await b.commitAll(sb, "thread anon");
  assert.equal(res.committed, true);
  assert.equal((await xgit(sb.path, ["log", "-1", "--format=%an"])).trim(), "pi-infinity");
});

test("R-S4 diffStat covers committed and uncommitted changes", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "a.txt", "base\n", "initial commit");
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "alpha" });
  assert.equal(await b.diffStat(sb), "(no changes)");
  writeFileSync(join(sb.path, "a.txt"), "edited\n");
  assert.match(await b.diffStat(sb), /a\.txt/);
  await b.commitAll(sb, "first edit");
  // An uncommitted edit to a tracked file must still show up against the base.
  writeFileSync(join(sb.path, "a.txt"), "edited again\n");
  const stat = await b.diffStat(sb);
  assert.match(stat, /a\.txt/);
});

test("R-S5 squash into a sandbox worktree commits the result", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const parent = await b.create({ cwd: repo, id: "parent" });
  const child = await b.create({ cwd: repo, id: "child", base: parent.branch });
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
  // Squash, not merge: the parent history gains exactly one commit.
  assert.equal((await xgit(parent.path, ["rev-list", "--count", "HEAD"])).trim(), "2");
  // Default message when none is given.
  assert.equal((await xgit(parent.path, ["log", "-1", "--format=%s"])).trim(), "squash sandbox-child");
  // The child branch is untouched by a successful squash.
  assert.equal((await xgit(repo, ["rev-parse", "sandbox-child"])).trim(), (await xgit(child.path, ["rev-parse", "HEAD"])).trim());
});

test("R-S7 squash markers do not mark later branch work merged", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "changed" });
  writeFileSync(join(sb.path, "first.txt"), "first\n");
  await b.commitAll(sb, "first");
  assert.equal((await b.squashInto(repo, sb, { commit: true })).ok, true);
  assert.equal((await b.list(repo))[0].merged, true);
  writeFileSync(join(sb.path, "second.txt"), "second\n");
  await b.commitAll(sb, "second");
  await b.remove(sb, { keepBranch: true });
  assert.equal((await b.list(repo))[0].merged, false);
  assert.deepEqual(await b.pruneMerged(repo), []);
  assert.equal((await xgit(repo, ["show", "sandbox-changed:second.txt"])).trim(), "second");
});

test("R-S7 legacy squash markers do not prove a branch merged", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "legacy" });
  await xgit(repo, ["config", "branch.sandbox-legacy.pi-infinity-squashed", repo]);
  await b.remove(sb, { keepBranch: true });
  assert.equal((await b.list(repo))[0].merged, false);
  assert.deepEqual(await b.pruneMerged(repo), []);
});

test("R-S5 squash into the main checkout without commit leaves changes staged", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "feature" });
  writeFileSync(join(sb.path, "file.txt"), "from sandbox\n");
  await b.commitAll(sb, "thread feature");
  const before = (await xgit(repo, ["rev-parse", "HEAD"])).trim();
  const res = await b.squashInto(repo, sb, { commit: false });
  if (!res.ok) {
    assert.fail(`expected squash to succeed: ${res.error}`);
  } else {
    assert.equal(res.filesChanged, 1);
    assert.equal(res.commitSha, undefined);
  }
  assert.equal((await xgit(repo, ["rev-parse", "HEAD"])).trim(), before);
  const status = await xgit(repo, ["status", "--porcelain"]);
  assert.match(status, /^M  file\.txt$/m);
  assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "from sandbox\n");
});

test("R-S5 a second child squashed after the first works when files differ", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
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
});

test("R-S6 conflicts abort the squash and leave the target and child branch intact", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "shared.txt", "base\n", "initial commit");
  const b = backend();
  const c1 = await b.create({ cwd: repo, id: "first" });
  const c2 = await b.create({ cwd: repo, id: "second" });
  writeFileSync(join(c1.path, "shared.txt"), "one\n");
  await b.commitAll(c1, "thread first");
  writeFileSync(join(c2.path, "shared.txt"), "two\n");
  await b.commitAll(c2, "thread second");
  const r1 = await b.squashInto(repo, c1, { commit: true });
  assert.equal(r1.ok, true);
  const res = await b.squashInto(repo, c2, { commit: true });
  if (res.ok) {
    assert.fail("expected the second squash to conflict");
  } else {
    assert.deepEqual(res.conflicts, ["shared.txt"]);
  }
  // The target is back to its pre-squash state: clean and at the first child's version.
  assert.equal((await xgit(repo, ["status", "--porcelain"])).trim(), "");
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "one\n");
  // The second child and its branch are untouched.
  assert.equal(readFileSync(join(c2.path, "shared.txt"), "utf8"), "two\n");
  assert.equal((await xgit(repo, ["rev-parse", "sandbox-second"])).trim(), (await xgit(c2.path, ["rev-parse", "HEAD"])).trim());
  assert.notEqual((await xgit(repo, ["rev-parse", "sandbox-second"])).trim(), (await xgit(repo, ["rev-parse", "HEAD"])).trim());
});

test("R-S5 squash refuses a target with uncommitted changes", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "feature" });
  writeFileSync(join(sb.path, "file.txt"), "from sandbox\n");
  await b.commitAll(sb, "thread feature");
  writeFileSync(join(repo, "file.txt"), "user edit\n");
  const res = await b.squashInto(repo, sb, { commit: true });
  if (res.ok) {
    assert.fail("expected the squash to be refused");
  } else {
    assert.deepEqual(res.conflicts, []);
    assert.match(res.error ?? "", /uncommitted or staged changes/);
  }
  assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "user edit\n");
});

test("R-S7 remove deletes the worktree and optionally the branch", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const keep = await b.create({ cwd: repo, id: "keep" });
  const gone = await b.create({ cwd: repo, id: "gone" });
  await b.remove(keep, { keepBranch: true });
  assert.equal(existsSync(keep.path), false);
  await xgit(repo, ["rev-parse", "--verify", "refs/heads/sandbox-keep"]);
  await b.remove(gone, { keepBranch: false });
  assert.equal(existsSync(gone.path), false);
  await assert.rejects(xgit(repo, ["rev-parse", "--verify", "refs/heads/sandbox-gone"]));
  const porcelain = await xgit(repo, ["worktree", "list", "--porcelain"]);
  assert.equal(porcelain.includes("sandbox-keep"), false);
  assert.equal(porcelain.includes("sandbox-gone"), false);
});

test("R-S7 list reports branches, worktrees and merged state", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
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
  // A fresh branch whose tip still equals its base has nothing to merge, so it is not merged.
  assert.equal(byId.get("untouched")?.merged, false);
  assert.equal(byId.get("untouched")?.hasWorktree, true);
});

test("R-S7 pruneMerged deletes merged branches without a worktree", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const a = await b.create({ cwd: repo, id: "a" });
  const c = await b.create({ cwd: repo, id: "c" });
  const kept = await b.create({ cwd: repo, id: "b" });
  for (const sb of [a, c]) {
    writeFileSync(join(sb.path, `${sb.id}.txt`), "x\n");
    await b.commitAll(sb, `thread ${sb.id}`);
    assert.equal((await b.squashInto(repo, sb, { commit: true })).ok, true);
    await b.remove(sb, { keepBranch: true });
  }
  // b still has a worktree, so it survives even though its branch is merged.
  const deleted = await b.pruneMerged(repo);
  assert.deepEqual(deleted, ["sandbox-a", "sandbox-c"]);
  await assert.rejects(xgit(repo, ["rev-parse", "--verify", "refs/heads/sandbox-a"]));
  await xgit(repo, ["rev-parse", "--verify", `refs/heads/${kept.branch}`]);
});

test("R-S1 a sandbox created from inside a sandbox lives under the main root", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const b = backend();
  const parent = await b.create({ cwd: repo, id: "parent" });
  // detect from inside a worktree reports that worktree, not the main checkout.
  const detected = await b.detect(parent.path);
  assert.equal(detected?.repoRoot, parent.path);
  const child = await b.create({ cwd: parent.path, id: "nested", base: parent.branch });
  assert.equal(child.repoRoot, repo);
  assert.equal(child.path, join(repo, ".pi", "sandboxes", "nested"));
  assert.equal(child.base, (await xgit(parent.path, ["rev-parse", parent.branch])).trim());
  writeFileSync(join(child.path, "nested.txt"), "from child\n");
  assert.equal(existsSync(join(parent.path, "nested.txt")), false);
});

test("R-S8 create and edit never touch the main checkout", async (t) => {
  const repo = await initRepo(t);
  await commitFile(repo, "file.txt", "base\n", "initial commit");
  const headBefore = (await xgit(repo, ["rev-parse", "HEAD"])).trim();
  const b = backend();
  const sb = await b.create({ cwd: repo, id: "worker" });
  writeFileSync(join(sb.path, "file.txt"), "sandbox edit\n");
  await b.commitAll(sb, "thread worker");
  assert.equal((await xgit(repo, ["rev-parse", "HEAD"])).trim(), headBefore);
  assert.equal((await xgit(repo, ["status", "--porcelain"])).trim(), "");
  assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");
});
