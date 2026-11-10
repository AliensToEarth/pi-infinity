import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig, type InfinityConfig } from "../extensions/lib/config.ts";
import { Emitter, type OutgoingMessage } from "../extensions/lib/events.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { GitSandbox } from "../extensions/lib/sandbox/git.ts";
import { BUILTIN_TOOLS, FALLBACK_MODEL, launchViaSubagents, promptBody, type ExecuteTool } from "../extensions/lib/threads/subagents.ts";
import { ThreadService, type DetachedLaunch, type ThreadIO } from "../extensions/lib/threads/service.ts";
import { ThreadFiles, frameTask, identify } from "../extensions/lib/threads/protocol.ts";
import { NO_TRANSPORT_MESSAGE, pickTransport, readAgentRegistry, type AgentRegistry } from "../extensions/lib/threads/transport.ts";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const registryCalls = () => {
  const calls: string[] = [];
  const registered = new Map<string, Parameters<AgentRegistry["registerAgent"]>[0]>();
  const registry: AgentRegistry = {
    registerAgent: (c) => {
      calls.push(`register ${c.name}`);
      registered.set(c.name, c);
    },
    unregisterAgent: (n) => {
      calls.push(`unregister ${n}`);
      registered.delete(n);
    },
  };
  return { calls, registered, registry };
};

test("R-X1 transport choice follows what is installed", () => {
  const both = ["subagent", "subagent_message", "subagents_list"];
  const only = ["subagent"];
  assert.equal(pickTransport("auto", both, true), "interactive");
  assert.equal(pickTransport("auto", both, false), "interactive");
  assert.equal(pickTransport("auto", only, true), "subagents");
  assert.equal(pickTransport("auto", only, false), "none");
  assert.equal(pickTransport("auto", [], true), "none");
  assert.equal(pickTransport("interactive", only, true), "none");
  assert.equal(pickTransport("subagents", both, true), "subagents");
  assert.equal(pickTransport("subagents", both, false), "none");
});

test("R-X1 the registry is read from the pi-subagents global only when complete", () => {
  assert.equal(readAgentRegistry({}), undefined);
  assert.equal(readAgentRegistry({ __pi_subagents: { registerAgent: () => {} } }), undefined);
  const full = { registerAgent: () => {}, unregisterAgent: () => {} };
  assert.equal(readAgentRegistry({ __pi_subagents: full }), full);
});

test("R-X1 config accepts the transport setting and rejects others", () => {
  const problems: string[] = [];
  const ok = mergeConfig(DEFAULT_CONFIG as never, { threads: { transport: "subagents" } }, "", problems) as InfinityConfig;
  assert.equal(ok.threads.transport, "subagents");
  assert.deepEqual(problems, []);
  mergeConfig(DEFAULT_CONFIG as never, { threads: { transport: "tmux" } }, "", problems);
  assert.match(problems[0], /must be auto, interactive or subagents/);
});

test("promptBody strips the frontmatter", () => {
  assert.equal(promptBody("---\nname: x\n---\n\nHello\nworld\n"), "Hello\nworld");
  assert.equal(promptBody("no frontmatter"), "no frontmatter");
});

test("R-X4 launch registers thread-<id> with built-in tools, calls subagent with agent, task and cwd only, then unregisters", async () => {
  const { calls, registered, registry } = registryCalls();
  let seen: { name: string; args: Record<string, unknown>; signal?: AbortSignal } | undefined;
  let finish: (v: { isError: boolean; result: { content: Array<{ type: string; text?: string }> } }) => void = () => {};
  const executeTool: ExecuteTool = (name, args, options) => {
    seen = { name, args: args as Record<string, unknown>, signal: options?.signal };
    assert.ok(registered.has("thread-t-abc123"), "agent must be registered before the call");
    return new Promise((resolve) => (finish = resolve));
  };
  const h = launchViaSubagents({
    registry,
    executeTool,
    id: "t-abc123",
    task: "do it",
    cwd: "/work",
    sessionModel: "openrouter/some/model",
    systemPrompt: "SYSTEM",
    promptFile: "/p.md",
  });
  assert.deepEqual(seen?.args, { agent: "thread-t-abc123", task: "do it", cwd: "/work" });
  assert.equal(seen?.name, "subagent");
  const agent = registered.get("thread-t-abc123");
  assert.deepEqual(agent?.tools, BUILTIN_TOOLS);
  assert.equal(agent?.model, "openrouter/some/model");
  assert.equal(agent?.systemPrompt, "SYSTEM");
  assert.deepEqual(calls, ["register thread-t-abc123"]);
  finish({ isError: false, result: { content: [{ type: "text", text: "final " }, { type: "image" }, { type: "text", text: "report" }] } });
  assert.deepEqual(await h.done, { output: "final \nreport", isError: false });
  assert.deepEqual(calls, ["register thread-t-abc123", "unregister thread-t-abc123"]);
});

test("R-X4 model precedence is spawn model, session model, then the pi-subagents default", () => {
  const model = (over: { model?: string; sessionModel?: string }) => {
    const { registered, registry } = registryCalls();
    launchViaSubagents({
      registry,
      executeTool: () => new Promise(() => {}),
      id: "t-000001",
      task: "x",
      systemPrompt: "s",
      promptFile: "f",
      ...over,
    });
    return registered.get("thread-t-000001")?.model;
  };
  assert.equal(model({ model: "a/b", sessionModel: "c/d" }), "a/b");
  assert.equal(model({ sessionModel: "c/d" }), "c/d");
  assert.equal(model({}), FALLBACK_MODEL);
});

test("R-X3 the nested call uses its own signal and abort() fires it", async () => {
  const { registry } = registryCalls();
  let signal: AbortSignal | undefined;
  const executeTool: ExecuteTool = (_n, _a, o) => {
    signal = o?.signal;
    return new Promise((_res, rej) => o?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  };
  const h = launchViaSubagents({ registry, executeTool, id: "t-000002", task: "x", systemPrompt: "s", promptFile: "f" });
  assert.ok(signal && !signal.aborted);
  h.abort();
  assert.equal(signal?.aborted, true);
  const res = await h.done;
  assert.equal(res.isError, true);
  assert.match(res.output, /aborted/);
});

test("R-X4 an error outcome and a throwing call both settle as errors and still unregister", async () => {
  const a = registryCalls();
  const failing = launchViaSubagents({
    registry: a.registry,
    executeTool: async () => ({ isError: true, result: { content: [{ type: "text", text: "Unknown agent" }] } }),
    id: "t-000003",
    task: "x",
    systemPrompt: "s",
    promptFile: "f",
  });
  assert.deepEqual(await failing.done, { output: "Unknown agent", isError: true });
  assert.equal(a.calls.at(-1), "unregister thread-t-000003");
  const b = registryCalls();
  const throwing = launchViaSubagents({
    registry: b.registry,
    executeTool: async () => {
      throw new Error("kaboom");
    },
    id: "t-000004",
    task: "x",
    systemPrompt: "s",
    promptFile: "f",
  });
  const res = await throwing.done;
  assert.equal(res.isError, true);
  assert.match(res.output, /kaboom/);
  assert.equal(b.calls.at(-1), "unregister thread-t-000004");
});

test("R-X4 non-Error rejections settle and still unregister the agent", async () => {
  for (const reason of [null, undefined, 0, "failed"]) {
    const { registry, registered } = registryCalls();
    const launch = launchViaSubagents({
      registry,
      executeTool: () => Promise.reject(reason),
      id: "t-000006",
      task: "x",
      systemPrompt: "s",
      promptFile: "f",
    });
    assert.deepEqual(await launch.done, { output: `subagent call failed: ${String(reason)}`, isError: true });
    assert.equal(registered.size, 0);
  }
  const { registry } = registryCalls();
  const launch = launchViaSubagents({
    registry,
    executeTool: () => Promise.reject(Object.create(null)),
    id: "t-000006",
    task: "x",
    systemPrompt: "s",
    promptFile: "f",
  });
  assert.match((await launch.done).output, /subagent call failed:.*null prototype/);
});

test("R-X4 unregister failures become error results without losing the report", async () => {
  const { registry } = registryCalls();
  registry.unregisterAgent = () => {
    throw new Error("registry unavailable");
  };
  const launch = launchViaSubagents({
    registry,
    executeTool: async () => ({ isError: false, result: { content: [{ type: "text", text: "result" }] } }),
    id: "t-000007",
    task: "x",
    systemPrompt: "s",
    promptFile: "f",
  });
  assert.deepEqual(await launch.done, { output: "result\nagent cleanup failed: registry unavailable", isError: true });
});

test("R-X4 a synchronous tool failure unregisters the agent before propagating", () => {
  const { calls, registered, registry } = registryCalls();
  assert.throws(
    () =>
      launchViaSubagents({
        registry,
        executeTool: () => {
          throw new Error("synchronous failure");
        },
        id: "t-000005",
        task: "x",
        systemPrompt: "s",
        promptFile: "f",
      }),
    /synchronous failure/,
  );
  assert.deepEqual(calls, ["register thread-t-000005", "unregister thread-t-000005"]);
  assert.equal(registered.size, 0);
});

test("R-X9 the subagents task frame names built-in tools and the final report, and has no close_thread procedure", () => {
  const t = frameTask({ id: "t-1a2b3c", stack: ["root", "t-1a2b3c"], fresh: true, instructions: "do X", transport: "subagents" });
  assert.match(t, /INSIDE thread t-1a2b3c, started by root/);
  assert.match(t, /built-in tools only/);
  assert.match(t, /LAST message is your final report/);
  assert.match(t, /There is no close_thread tool/);
  assert.doesNotMatch(t, /report_to_parent for intermediate/);
  const sb = frameTask({
    id: "t-1a2b3c",
    stack: ["root", "t-1a2b3c"],
    fresh: true,
    instructions: "x",
    transport: "subagents",
    sandbox: { path: "/p", branch: "sandbox-t" },
  });
  assert.match(sb, /isolated checkout at \/p on branch sandbox-t/);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

interface Detached {
  io: ThreadIO;
  svc: ThreadService;
  sent: OutgoingMessage[];
  repo: string;
  files: ThreadFiles;
  launches: Array<{ id: string; task: string; cwd?: string; model?: string }>;
  resolve(v: { output: string; isError: boolean }): void;
  aborted: () => number;
  messages: string[];
}

function detached(over: Partial<ThreadIO> = {}): Detached {
  const repo = tmp("pi-inf-x-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@example.org");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const files = new ThreadFiles(tmp("pi-inf-x-agent-"));
  const sent: OutgoingMessage[] = [];
  const logger = memoryLogger();
  const emitter = new Emitter({ send: (m) => void sent.push(m), spillDir: tmp("pi-inf-x-sp-"), maxChars: 4000, seenCap: 100, logger });
  const sandboxes = [new GitSandbox(logger, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" })];
  const svc = new ThreadService({ identity: identify({}, files), files, sandboxes, emitter, config: DEFAULT_CONFIG, logger });
  const launches: Detached["launches"] = [];
  let aborts = 0;
  let resolve: Detached["resolve"] = () => {};
  const io: ThreadIO = {
    transport: "subagents",
    cwd: repo,
    launch: async () => assert.fail("interactive launch must not be used"),
    sendToChild: async () => assert.fail("messaging must not be used"),
    launchDetached: (a): DetachedLaunch => {
      launches.push(a);
      return {
        done: new Promise((r) => (resolve = r)),
        abort: () => void aborts++,
      };
    },
    ...over,
  };
  return { io, svc, sent, repo, files, launches, resolve: (v) => resolve(v), aborted: () => aborts, messages: [] };
}

test("R-X5 fork requests are rejected before any side effect", async () => {
  const d = detached();
  await assert.rejects(d.svc.spawn({ instructions: "x", child_of: ["root"], sandbox: true }, d.io), /fresh_context: true/);
  await assert.rejects(
    d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: false, sandbox: true }, d.io),
    /always start with an empty context/,
  );
  assert.equal(d.launches.length, 0);
  assert.equal(git(d.repo, "branch", "--list", "sandbox-*"), "");
  assert.equal(d.svc.list().length, 0);
});

test("R-X1 without a transport spawn_thread explains itself", async () => {
  const d = detached({ transport: "none" });
  await assert.rejects(
    d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true }, d.io),
    (e: Error) => e.message === NO_TRANSPORT_MESSAGE,
  );
});

test("R-X3 R-X6 spawn returns at once, the close event carries the final output, no thread file is written", async () => {
  const d = detached();
  const { id, text } = await d.svc.spawn({ instructions: "do X", child_of: ["root"], fresh_context: true, model: "p/m" }, d.io);
  assert.match(text, /final report arrives as one \[infinity event\]/);
  assert.equal(d.launches[0].id, id);
  assert.equal(d.launches[0].model, "p/m");
  assert.match(d.launches[0].task, /built-in tools only/);
  assert.equal(d.files.read(id), null);
  assert.equal(d.sent.length, 0, "nothing is delivered before the child ends");
  assert.equal(d.svc.list()[0].transport, "subagents");
  assert.equal(d.svc.runningCount(), 1);
  d.resolve({ output: "all done, 2 files", isError: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].details.kind, "child_closed");
  assert.match(d.sent[0].content, /has finished\. Final report: all done, 2 files/);
  assert.equal(d.svc.hasClosed(id), true);
});

test("R-H6a R-RLM2 blocking structured final report is rendered in the close event", async () => {
  const d = detached();
  await d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true }, d.io);
  d.resolve({
    output: JSON.stringify({
      summary: "Done",
      files: ["a.ts"],
      blockers: ["none"],
      evidence: [{ source: "a.ts", start: 1, end: 2, claim: "finding" }],
    }),
    isError: false,
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(d.sent[0].content, /Done\nFiles: a.ts\nBlockers: none\nEvidence \(unverified\): a.ts:1-2: finding/);
});

test("R-X6 an error outcome is labeled", async () => {
  const d = detached();
  await d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true }, d.io);
  d.resolve({ output: "Error: exit 1", isError: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(d.sent[0].content, /has finished with an error\. Final report: Error: exit 1/);
});

async function waitForClosed(svc: { hasClosed(id: string): boolean }, id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!svc.hasClosed(id)) {
    if (Date.now() >= deadline) throw new Error(`thread ${id} did not finish finalizing`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("R-X6 a sandbox is committed and its diff stat listed when the call settles", async () => {
  const d = detached();
  const { id } = await d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true, sandbox: true }, d.io);
  const cwd = d.launches[0].cwd as string;
  assert.ok(cwd.endsWith(id) && existsSync(cwd));
  writeFileSync(join(cwd, "child.txt"), "hi\n");
  d.resolve({ output: "made child.txt", isError: false });
  await waitForClosed(d.svc, id);
  assert.match(d.sent[0].content, /child\.txt/);
  assert.match(d.sent[0].content, /squash_sandbox/);
  assert.match(git(d.repo, "log", "--oneline", `sandbox-${id}`), /thread t-/);
});

test("R-S5 squash rejects a running or finalizing subagents sandbox", async () => {
  const d = detached();
  const { id } = await d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true, sandbox: true }, d.io);
  const cwd = d.launches[0].cwd as string;
  writeFileSync(join(cwd, "child.txt"), "hi\n");
  let confirmations = 0;
  const io = {
    ...d.io,
    confirm: async () => {
      confirmations++;
      return true;
    },
  };
  await assert.rejects(d.svc.squash(id, {}, io), /still running or finalizing/);
  d.resolve({ output: "done", isError: false });
  await Promise.resolve();
  assert.equal(d.svc.hasClosed(id), false);
  await assert.rejects(d.svc.squash(id, {}, io), /still running or finalizing/);
  assert.equal(confirmations, 0);
  assert.ok(existsSync(cwd));
  await waitForClosed(d.svc, id);
  assert.equal(d.svc.hasClosed(id), true);
  await d.svc.squash(id, {}, io);
  assert.equal(git(d.repo, "diff", "--cached", "--name-only"), "child.txt");
});

test("R-X7 messaging a subagents thread fails clearly", async () => {
  const d = detached();
  const { id } = await d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true }, d.io);
  await assert.rejects(d.svc.sendToChild(id, "hi", d.io), /pi-subagents, which cannot take messages/);
});

test("R-X8 dispose aborts running threads, keeps the sandbox and emits nothing", async () => {
  const d = detached();
  const { id } = await d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true, sandbox: true }, d.io);
  d.svc.dispose();
  assert.equal(d.aborted(), 1);
  d.resolve({ output: "aborted", isError: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(d.sent.length, 0);
  assert.match(git(d.repo, "branch", "--list", `sandbox-${id}`), /sandbox-t-/);
});

test("R-X8 shutdown during sandbox creation never launches a child and keeps the sandbox", async () => {
  const d = detached();
  const pick = d.svc.pickBackend.bind(d.svc);
  let release!: () => void;
  let created!: () => void;
  const ready = new Promise<void>((resolve) => (created = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  d.svc.pickBackend = async (cwd) => {
    const picked = await pick(cwd);
    assert.ok(picked);
    const create = picked.backend.create.bind(picked.backend);
    picked.backend.create = async (args) => {
      const sandbox = await create(args);
      created();
      await gate;
      return sandbox;
    };
    return picked;
  };
  const spawning = d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true, sandbox: true }, d.io);
  await ready;
  d.svc.dispose();
  release();
  await assert.rejects(spawning, /session has ended/);
  assert.equal(d.launches.length, 0);
  assert.match(git(d.repo, "branch", "--list", "sandbox-*"), /sandbox-t-/);
  await assert.rejects(d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true }, d.io), /session has ended/);
});

test("R-X10 several threads run side by side and close independently", async () => {
  const d = detached();
  const resolvers: Array<(v: { output: string; isError: boolean }) => void> = [];
  const io: ThreadIO = {
    ...d.io,
    launchDetached: () => ({ done: new Promise((r) => resolvers.push(r)), abort: () => {} }),
  };
  const a = await d.svc.spawn({ instructions: "a", child_of: ["root"], fresh_context: true }, io);
  const b = await d.svc.spawn({ instructions: "b", child_of: ["root"], fresh_context: true }, io);
  assert.equal(d.svc.runningCount(), 2);
  resolvers[1]({ output: "b done", isError: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.svc.hasClosed(b.id), true);
  assert.equal(d.svc.hasClosed(a.id), false);
  assert.match(d.sent[0].content, /b done/);
  resolvers[0]({ output: "a done", isError: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.sent.length, 2);
});

test("R-X2 a launch failure on the subagents transport cleans the sandbox", async () => {
  const d = detached({
    launchDetached: () => {
      throw new Error("registry exploded");
    },
  });
  await assert.rejects(
    d.svc.spawn({ instructions: "x", child_of: ["root"], fresh_context: true, sandbox: true }, d.io),
    /registry exploded/,
  );
  assert.equal(git(d.repo, "branch", "--list", "sandbox-*"), "");
  assert.equal(d.svc.list().length, 0);
});
