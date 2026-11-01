import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { Emitter, type OutgoingMessage } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { GitSandbox } from "../extensions/lib/sandbox.ts";
import { JjSandbox } from "../extensions/lib/sandbox-jj.ts";
import { hasJj } from "./helpers.ts";
import { ThreadService, type ThreadIO } from "../extensions/lib/thread-service.ts";
import {
  AGENT_FORK,
  AGENT_FRESH,
  InboxWatcher,
  ThreadFiles,
  appendInbox,
  checkChildOf,
  frameTask,
  identify,
  inboxPath,
  type InboxLine,
} from "../extensions/lib/threads.ts";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

test("R-H1 child_of must equal the caller's real stack", () => {
  assert.deepEqual(checkChildOf(["root"], ["root"], 4), { ok: true });
  const bad = checkChildOf(["root", "t-aaaaaa"], ["root"], 4);
  assert.equal(bad.ok, false);
  assert.match((bad as { message: string }).message, /You are thread t-aaaaaa.*do not spawn the parent's threads/);
  assert.equal(checkChildOf(["root"], [], 4).ok, false);
});

test("R-H9 depth is capped", () => {
  const r = checkChildOf(["root", "t-000001", "t-000002", "t-000003"], ["root", "t-000001", "t-000002", "t-000003"], 4);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /depth limit/);
});

test("R-H3 task frame names id, stack, parent, freshness and the closing procedure", () => {
  const t = frameTask({ id: "t-1a2b3c", stack: ["root", "t-1a2b3c"], fresh: true, instructions: "do X" });
  assert.match(t, /thread t-1a2b3c.*\[root, t-1a2b3c\].*parent is root/);
  assert.match(t, /self-contained/);
  assert.match(t, /close_thread/);
  assert.match(
    frameTask({ id: "t-1a2b3c", stack: ["root", "t-1a2b3c"], fresh: false, instructions: "x" }),
    /inherited your parent's conversation/,
  );
  assert.match(
    frameTask({
      id: "t-1a2b3c",
      stack: ["root", "t-1a2b3c"],
      fresh: false,
      instructions: "x",
      sandbox: { path: "/p", branch: "sandbox-t" },
    }),
    /git worktree at \/p on branch sandbox-t/,
  );
});

test("R-H4 identify returns root without a record and the stack with one", () => {
  const files = new ThreadFiles(tmp("pi-inf-th-"));
  assert.equal(identify({}, files).id, "root");
  assert.equal(identify({ PI_SUBAGENT_NAME: "t-abcdef" }, files).id, "root");
  files.write({
    id: "t-abcdef",
    parentId: "root",
    stack: ["root", "t-abcdef"],
    instructions: "i",
    fresh: true,
    createdAt: 1,
    status: "running",
  });
  const me = identify({ PI_SUBAGENT_NAME: "t-abcdef", PI_SUBAGENT_SESSION: "/s/x.jsonl" }, files);
  assert.deepEqual(me.stack, ["root", "t-abcdef"]);
  assert.equal(me.inboxFile, "/s/x.jsonl.reports.jsonl");
  assert.throws(() => files.pathFor("../evil"), /bug: invalid thread id/);
});

test("R-H5 inbox watcher delivers whole lines once and waits for partial lines", () => {
  const dir = tmp("pi-inf-ib-");
  const file = join(dir, "s.reports.jsonl");
  const got: InboxLine[] = [];
  const w = new InboxWatcher({ file, onLine: (l) => got.push(l), logger: memoryLogger() });
  w.drain();
  appendInbox(file, { type: "report", seq: 0, text: "a", at: 1 });
  writeFileSync(file, readFileSync(file, "utf8") + '{"type":"report","seq":1,"te');
  w.drain();
  assert.equal(got.length, 1);
  writeFileSync(file, readFileSync(file, "utf8") + 'xt":"b","at":2}\n');
  w.drain();
  w.drain();
  assert.deepEqual(
    got.map((l) => l.text),
    ["a", "b"],
  );
});

test("R-H5 inbox watcher preserves UTF-8 split across reads", () => {
  const file = join(tmp("pi-inf-ib-"), "s.reports.jsonl");
  const got: InboxLine[] = [];
  const w = new InboxWatcher({ file, onLine: (line) => got.push(line), logger: memoryLogger() });
  const bytes = Buffer.from(JSON.stringify({ type: "report", seq: 0, text: "hello 🌍", at: 1 }) + "\n");
  const split = bytes.indexOf(Buffer.from("🌍")) + 2;
  writeFileSync(file, bytes.subarray(0, split));
  w.drain();
  writeFileSync(file, bytes.subarray(split), { flag: "a" });
  w.drain();
  assert.equal(got[0]?.text, "hello 🌍");
});

test("R-H5 bad inbox lines are logged, not thrown", () => {
  const dir = tmp("pi-inf-ib-");
  const file = join(dir, "s.reports.jsonl");
  writeFileSync(file, "not json\n");
  const logger = memoryLogger();
  new InboxWatcher({ file, onLine: () => assert.fail("no line expected"), logger }).drain();
  assert.equal(logger.lines.length, 1);
});

interface Harness {
  svc: ThreadService;
  sent: OutgoingMessage[];
  launches: Array<{ agent: string; task: string; name: string; cwd?: string; model?: string }>;
  io: ThreadIO;
  files: ThreadFiles;
  repo: string;
  messages: Array<[string, string]>;
  sessionDir: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function harness(opts: { confirm?: boolean } = {}): Harness {
  const repo = tmp("pi-inf-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.org");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const sessionDir = tmp("pi-inf-sess-");
  const files = new ThreadFiles(tmp("pi-inf-agent-"));
  const sent: OutgoingMessage[] = [];
  const logger = memoryLogger();
  const emitter = new Emitter({
    send: (m) => void sent.push(m),
    spillDir: join(sessionDir, "spill"),
    maxChars: 4000,
    seenCap: 100,
    logger,
  });
  const sandboxes = [new GitSandbox(logger, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" })];
  const svc = new ThreadService({ identity: identify({}, files), files, sandboxes, emitter, config: DEFAULT_CONFIG, logger, pollMs: 20 });
  const launches: Harness["launches"] = [];
  const messages: Array<[string, string]> = [];
  const io: ThreadIO = {
    cwd: repo,
    launch: async (a) => {
      launches.push(a);
      return { sessionFile: join(sessionDir, `${a.name}.jsonl`) };
    },
    sendToChild: async (n, m) => void messages.push([n, m]),
    confirm: opts.confirm ? async () => true : undefined,
  };
  return { svc, sent, launches, io, files, repo, messages, sessionDir };
}

test("R-H1 spawn rejects a stack mismatch before launching anything", async () => {
  const h = harness();
  await assert.rejects(h.svc.spawn({ instructions: "x", child_of: ["t-nope00"] }, h.io), /do not spawn the parent's threads/);
  assert.equal(h.launches.length, 0);
});

test("R-H2 fresh_context selects thread-fresh, default selects thread-fork", async () => {
  const h = harness();
  const a = await h.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true }, h.io);
  const b = await h.svc.spawn({ instructions: "y", child_of: ["root"] }, h.io);
  assert.equal(h.launches[0].agent, AGENT_FRESH);
  assert.equal(h.launches[1].agent, AGENT_FORK);
  assert.equal(h.launches[0].name, a.id);
  assert.match(h.launches[1].task, new RegExp(`INSIDE thread ${b.id}`));
  assert.ok(h.files.read(a.id), "thread file written for the child to read");
  h.svc.dispose();
});

test("R-H5 R-H6 reports and close arrive as one event each, thread file removed on close", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"] }, h.io);
  const inbox = inboxPath(join(h.sessionDir, `${id}.jsonl`));
  appendInbox(inbox, { type: "report", seq: 0, text: "halfway", at: 1 });
  appendInbox(inbox, { type: "closed", seq: 1, text: "all done", at: 2 });
  await until(() => h.sent.length >= 2);
  h.svc.drainAll();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].details.kind, "child_report");
  assert.match(h.sent[0].content, /halfway/);
  assert.equal(h.sent[1].details.kind, "child_closed");
  assert.match(h.sent[1].content, /all done/);
  assert.equal(h.files.read(id), null);
  assert.equal(h.svc.list()[0].status, "closed");
});

test("R-H6a interactive structured reports are rendered in parent events", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"] }, h.io);
  const inbox = inboxPath(join(h.sessionDir, `${id}.jsonl`));
  appendInbox(inbox, { type: "report", seq: 0, text: JSON.stringify({ summary: "Progress", files: ["a.ts"] }), at: 1 });
  appendInbox(inbox, { type: "closed", seq: 1, text: JSON.stringify({ summary: "Done", tests: ["passed"] }), at: 2 });
  await until(() => h.sent.length >= 2);
  assert.match(h.sent[0].content, /Progress\nFiles: a.ts/);
  assert.match(h.sent[1].content, /Done\nTests: passed/);
  h.svc.dispose();
});

test("R-H6 child side tools write to the inbox and refuse in the root session", () => {
  const dir = tmp("pi-inf-child-");
  const files = new ThreadFiles(dir);
  files.write({
    id: "t-abcdef",
    parentId: "root",
    stack: ["root", "t-abcdef"],
    instructions: "i",
    fresh: true,
    createdAt: 1,
    status: "running",
  });
  const sessionFile = join(dir, "s.jsonl");
  const logger = memoryLogger();
  const emitter = new Emitter({ send: () => {}, spillDir: dir, maxChars: 100, seenCap: 5, logger });
  const mk = (env: NodeJS.ProcessEnv) =>
    new ThreadService({
      identity: identify(env, files),
      files,
      sandboxes: [new GitSandbox(logger)],
      emitter,
      config: DEFAULT_CONFIG,
      logger,
    });
  const child = mk({ PI_SUBAGENT_NAME: "t-abcdef", PI_SUBAGENT_SESSION: sessionFile });
  child.report("r1");
  child.close("fin");
  const lines = readFileSync(inboxPath(sessionFile), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.type, l.seq, l.text]),
    [
      ["report", 0, "r1"],
      ["closed", 1, "fin"],
    ],
  );
  assert.throws(() => mk({}).report("x"), /only inside a thread/);
  assert.throws(() => mk({}).close(), /only inside a thread/);
});

test("R-H7 closed threads reject messaging instead of silently losing the message", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"] }, h.io);
  await h.svc.childExited(id);
  await assert.rejects(h.svc.sendToChild(id, "hello", h.io), /closed and cannot be resumed/);
  assert.deepEqual(h.messages, []);
  h.svc.dispose();
});

test("R-H7 messages are rejected while a sandboxed child is closing", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, h.io);
  const closing = h.svc.childExited(id);
  await assert.rejects(h.svc.sendToChild(id, "hello", h.io), /closed and cannot be resumed/);
  await closing;
  assert.deepEqual(h.messages, []);
  h.svc.dispose();
});

test("R-H7 send_message_to_child accepts only direct children", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"] }, h.io);
  await h.svc.sendToChild(id, "hello", h.io);
  assert.deepEqual(h.messages, [[id, "hello"]]);
  await assert.rejects(h.svc.sendToChild("t-ffffff", "hi", h.io), /not a direct child/);
  h.svc.dispose();
});

test("R-S1 R-S3 R-S4 sandbox thread gets a worktree, close commits and reports the diff", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, h.io);
  const cwd = h.launches[0].cwd as string;
  assert.ok(cwd.startsWith(h.repo) && cwd.endsWith(id));
  writeFileSync(join(cwd, "b.txt"), "from child\n");
  appendInbox(inboxPath(join(h.sessionDir, `${id}.jsonl`)), { type: "closed", seq: 0, text: "done", at: 1 });
  await until(() => h.sent.length === 1);
  assert.match(h.sent[0].content, /sandbox-t-/);
  assert.match(h.sent[0].content, /b\.txt/);
  assert.match(h.sent[0].content, /squash_sandbox/);
  assert.match(git(h.repo, "log", "--oneline", `sandbox-${id}`), /thread t-/);
});

test("R-S1 sandbox outside a git repo fails before spawning", async () => {
  const h = harness();
  const plain = tmp("pi-inf-plain-");
  await assert.rejects(
    h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, { ...h.io, cwd: plain }),
    /needs a git or jj repository/,
  );
  assert.equal(h.launches.length, 0);
});

test("R-S1 launch failure cleans up the worktree and thread file", async () => {
  const h = harness();
  const io: ThreadIO = {
    ...h.io,
    launch: async () => {
      throw new Error("subagent exploded");
    },
  };
  await assert.rejects(h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, io), /subagent exploded/);
  assert.equal(git(h.repo, "branch", "--list", "sandbox-*"), "");
  assert.equal(git(h.repo, "worktree", "list").split("\n").length, 1);
});

test("R-S5 root squash needs confirmation, stages and does not commit", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, h.io);
  writeFileSync(join(h.launches[0].cwd as string, "b.txt"), "x\n");
  await h.svc.childExited(id);
  await assert.rejects(h.svc.squash(id, {}, h.io), /needs the user to confirm/);
  const withUi = { ...h.io, confirm: async () => true };
  const msg = await h.svc.squash(id, {}, withUi);
  assert.match(msg, /staged and not committed/);
  assert.equal(git(h.repo, "diff", "--cached", "--name-only"), "b.txt");
  assert.equal(git(h.repo, "log", "--oneline").split("\n").length, 1);
  assert.ok(!existsSync(h.launches[0].cwd as string), "worktree removed");
  assert.match(git(h.repo, "branch", "--list", `sandbox-${id}`), /sandbox-t-/);
});

test("R-S5 declined confirmation changes nothing", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, h.io);
  writeFileSync(join(h.launches[0].cwd as string, "b.txt"), "x\n");
  await h.svc.childExited(id);
  await assert.rejects(h.svc.squash(id, {}, { ...h.io, confirm: async () => false }), /declined/);
  assert.equal(git(h.repo, "diff", "--cached", "--name-only"), "");
});

test("R-S6 conflict surfaces the path and leaves the target clean", async () => {
  const h = harness();
  const a = await h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, h.io);
  const b = await h.svc.spawn({ instructions: "y", child_of: ["root"], sandbox: true }, h.io);
  writeFileSync(join(h.launches[0].cwd as string, "a.txt"), "child a\n");
  writeFileSync(join(h.launches[1].cwd as string, "a.txt"), "child b\n");
  const io = { ...h.io, confirm: async () => true };
  await h.svc.childExited(a.id);
  await h.svc.childExited(b.id);
  await h.svc.squash(a.id, { commit: true }, io);
  git(h.repo, "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-q", "-m", "take a");
  await assert.rejects(h.svc.squash(b.id, {}, io), /conflicts in: a\.txt/);
  assert.equal(git(h.repo, "status", "--porcelain"), "");
  assert.match(git(h.repo, "branch", "--list", `sandbox-${b.id}`), /sandbox-t-/);
});

test("B-5 a thread that exits without close_thread is closed and its sandbox committed", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, h.io);
  writeFileSync(join(h.launches[0].cwd as string, "late.txt"), "x\n");
  assert.equal(h.svc.hasClosed(id), false);
  await h.svc.childExited(id);
  assert.equal(h.svc.hasClosed(id), true);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].content, /ended without calling close_thread/);
  assert.match(git(h.repo, "show", "--stat", "--format=%s", `sandbox-${id}`), /late\.txt/);
  await h.svc.childExited(id);
  assert.equal(h.sent.length, 1, "second exit is a no-op");
});

test("R-S7 listing and pruning sandboxes", async () => {
  const h = harness();
  const { id } = await h.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, h.io);
  writeFileSync(join(h.launches[0].cwd as string, "b.txt"), "x\n");
  assert.match(await h.svc.listSandboxes(h.repo), new RegExp(`sandbox-${id}  open`));
  await h.svc.childExited(id);
  const io = { ...h.io, confirm: async () => true };
  await h.svc.squash(id, {}, io);
  assert.match(await h.svc.pruneSandboxes(io), /refused.*not committed/);
  git(h.repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "apply child work");
  assert.match(await h.svc.listSandboxes(h.repo), /merged/);
  assert.match(await h.svc.pruneSandboxes(io), /deleted 1/);
  assert.equal(git(h.repo, "branch", "--list", "sandbox-*"), "");
  assert.equal(await h.svc.pruneSandboxes({ ...h.io, confirm: undefined }), "pruning needs a UI to confirm");
});

test(
  "R-S1 R-S5 auto backend picks jj for a jj repository and squashes into the working copy",
  { skip: hasJj ? false : "jj is not installed" },
  async () => {
    const repo = tmp("pi-inf-jjrepo-");
    const cfg = join(tmp("pi-inf-jjcfg-"), "config.toml");
    writeFileSync(cfg, "");
    const env = { ...process.env, JJ_CONFIG: cfg, JJ_USER: "t", JJ_EMAIL: "t@example.org" };
    execFileSync("jj", ["git", "init", "--colocate", repo], { env, stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("jj", ["commit", "-m", "init"], { cwd: repo, env, stdio: "ignore" });

    const files = new ThreadFiles(tmp("pi-inf-agent-"));
    const sent: OutgoingMessage[] = [];
    const logger = memoryLogger();
    const emitter = new Emitter({ send: (m) => void sent.push(m), spillDir: tmp("pi-inf-sp-"), maxChars: 4000, seenCap: 100, logger });
    const sandboxes = [new JjSandbox(logger, env), new GitSandbox(logger)];
    const svc = new ThreadService({ identity: identify({}, files), files, sandboxes, emitter, config: DEFAULT_CONFIG, logger, pollMs: 20 });
    const sessionDir = tmp("pi-inf-sess-");
    const launches: Array<{ cwd?: string; name: string }> = [];
    const io: ThreadIO = {
      cwd: repo,
      launch: async (a) => {
        launches.push(a);
        return { sessionFile: join(sessionDir, `${a.name}.jsonl`) };
      },
      sendToChild: async () => {},
      confirm: async () => true,
    };
    const { id } = await svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, io);
    assert.ok(existsSync(join(launches[0].cwd as string, "a.txt")));
    writeFileSync(join(launches[0].cwd as string, "b.txt"), "from child\n");
    await svc.childExited(id);
    assert.match(sent[0].content, /b\.txt/);
    const msg = await svc.squash(id, {}, io);
    assert.match(msg, /left in your working-copy change/);
    assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "from child\n");
    svc.dispose();
  },
);
