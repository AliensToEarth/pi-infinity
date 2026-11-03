import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import piInfinity from "../extensions/index.ts";
import { interactiveAgentName } from "../extensions/tools/threads.ts";

// These adapter tests exercise a root session, even when the test runner is itself a subagent.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
}

type Handler = (event: any, ctx: any) => any;

function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, unknown>();
  const sent: any[] = [];
  const entries: Array<[string, unknown]> = [];
  const pi = {
    registerTool: (t: any) => void tools.set(t.name, t),
    on: (name: string, h: Handler) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (name: string, c: any) => void commands.set(name, c),
    registerMessageRenderer: (name: string, r: unknown) => void renderers.set(name, r),
    sendMessage: (m: any, o: any) => void sent.push({ m, o }),
    appendEntry: (type: string, data: unknown) => void entries.push([type, data]),
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
  };
  const emit = async (name: string, event: unknown, ctx: unknown) => {
    let last: unknown;
    for (const h of handlers.get(name) ?? []) last = (await h(event, ctx)) ?? last;
    return last;
  };
  return { pi, tools, commands, renderers, sent, entries, emit };
}

function fakeCtx(cwd = tmpdir()) {
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: { getSessionFile: () => undefined, getSessionDir: () => cwd, getSessionId: () => "s1", getBranch: () => [] },
  };
}

async function started() {
  const f = fakePi();
  piInfinity(f.pi as never);
  const ctx = fakeCtx(mkdtempSync(join(tmpdir(), "pi-inf-ad-")));
  await f.emit("session_start", { type: "session_start" }, ctx);
  return { ...f, ctx };
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const EXPECTED_ROOT_TOOLS = [
  "bg_run",
  "bg_output",
  "bg_cancel",
  "bg_list",
  "sleep",
  "sleep_until",
  "sleep_until_event",
  "timer_cancel",
  "spawn_thread",
  "assess_coverage",
  "send_message_to_child",
  "squash_sandbox",
];

test("registers the documented tool set in a root session", async () => {
  const s = await started();
  assert.deepEqual([...s.tools.keys()].sort(), [...EXPECTED_ROOT_TOOLS].sort());
  assert.ok(s.renderers.has("infinity-event"));
  assert.ok(s.commands.has("infinity"));
});

test("R-G2 tool descriptions are short and carry the key guidance", async () => {
  const s = await started();
  for (const [name, t] of s.tools) assert.ok(t.description.length < 900, `${name} description is ${t.description.length} chars`);
  assert.match(s.tools.get("bg_run").description, /Never poll/);
  assert.match(s.tools.get("bg_run").description, /already-exited shell may survive/);
  assert.match(s.tools.get("bg_run").description, /\[infinity event\]/);
  assert.match(s.tools.get("sleep").description, /ends your turn/);
  assert.match(s.tools.get("spawn_thread").description, /child_of/);
  assert.match(s.tools.get("spawn_thread").description, /fresh_context/);
});

test("R-RLM1 thread guidance calls for bounded, traceable delegation and coverage checks", async () => {
  const s = await started();
  const guidance = s.tools.get("spawn_thread").promptGuidelines.join(" ");
  assert.match(guidance, /sources in files/);
  assert.match(guidance, /bounded portions/);
  assert.match(guidance, /inspect metadata and search first/);
  assert.match(guidance, /scripts for exact aggregation/);
  assert.match(guidance, /source locations/);
  assert.match(guidance, /limit fanout/);
  assert.match(guidance, /missing or failed portions/);
  assert.match(guidance, /closing does not prove success/);
});

test("R-RLM3 registered coverage tool compares ranges without accessing files", async () => {
  const s = await started();
  const result = await s.tools.get("assess_coverage").execute("coverage", {
    assigned: [{ source: "missing.txt", start: 1, end: 10 }],
    coverage: [{ source: "missing.txt", start: 1, end: 4, status: "read" }],
  });
  assert.deepEqual(result.details.missing, [{ source: "missing.txt", start: 5, end: 10 }]);
});

test("R-RLM5 guidance records the inspection trail and reconciles unverified reports", async () => {
  const s = await started();
  const guidance = s.tools.get("spawn_thread").promptGuidelines.join(" ");
  assert.match(guidance, /inspected, skipped, and unresolved/);
  assert.match(guidance, /assess_coverage/);
  assert.match(guidance, /check citations against sources/);
});

test("R-B1 R-B4 bash guard blocks long sleeps and sets a default timeout", async () => {
  const s = await started();
  const blocked = await s.emit("tool_call", { toolName: "bash", input: { command: "sleep 60" } }, s.ctx);
  assert.equal((blocked as { block: boolean }).block, true);
  assert.match((blocked as { reason: string }).reason, /bg_run/);
  const ev = { toolName: "bash", input: { command: "ls" } as { command: string; timeout?: number } };
  assert.equal(await s.emit("tool_call", ev, s.ctx), undefined);
  assert.equal(ev.input.timeout, 180);
  const own = { toolName: "bash", input: { command: "ls", timeout: 5 } };
  await s.emit("tool_call", own, s.ctx);
  assert.equal(own.input.timeout, 5);
});

test("R-O1 oversized results are replaced, read is exempt", async () => {
  const s = await started();
  const big = { type: "text", text: "z".repeat(50000) };
  const res = (await s.emit("tool_result", { toolName: "web_fetch", content: [big], isError: false }, s.ctx)) as {
    content: Array<{ text: string }>;
  };
  assert.ok(res.content[0].text.length < 10000);
  assert.equal(await s.emit("tool_result", { toolName: "read", content: [big], isError: false }, s.ctx), undefined);
});

test("R-O1 oversized structured results retain structuredContent while text is guarded", async () => {
  const s = await started();
  const structuredContent = { items: ["original"], nested: { count: 1 } };
  const big = { type: "text", text: "z".repeat(50000) };
  const res = (await s.emit("tool_result", { toolName: "web_fetch", content: [big], structuredContent, isError: false }, s.ctx)) as {
    content: Array<{ text: string }>;
    structuredContent: unknown;
  };
  assert.ok(res.content[0].text.length < 10000);
  assert.equal(res.structuredContent, structuredContent);
  assert.equal(
    await s.emit(
      "tool_result",
      { toolName: "web_fetch", content: [{ type: "text", text: "small" }], structuredContent, isError: false },
      s.ctx,
    ),
    undefined,
  );
  assert.equal(await s.emit("tool_result", { toolName: "read", content: [big], structuredContent, isError: false }, s.ctx), undefined);
});

test("R-J1 R-J4 bg_run returns at once and the exit arrives as a steer event", async () => {
  const s = await started();
  const t0 = Date.now();
  const out = await s.tools.get("bg_run").execute("call-1", { command: "echo hi; exit 2" }, undefined, undefined, s.ctx);
  assert.ok(Date.now() - t0 < 300);
  assert.match(out.content[0].text, /Job j1 started/);
  await until(() => s.sent.length > 0);
  const { m, o } = s.sent[0];
  assert.equal(m.customType, "infinity-event");
  assert.match(m.content, /exit code 2/);
  assert.match(m.content, /call-1/);
  assert.deepEqual(o, { triggerTurn: true, deliverAs: "steer" });
});

test("R-J8 bg_cancel on an unknown id is an error result", async () => {
  const s = await started();
  await assert.rejects(s.tools.get("bg_cancel").execute("c", { id: "j9" }, undefined, undefined, s.ctx), /unknown job id/);
});

test("R-T1 R-T4 sleep ends the turn, persists the timer and fires an event", async () => {
  const s = await started();
  const out = await s.tools.get("sleep").execute("c", { seconds: 1, note: "check build" }, undefined, undefined, s.ctx);
  assert.equal(out.terminate, true);
  assert.equal(s.entries[0][0], "infinity-timer");
  assert.equal((s.entries[0][1] as { op: string }).op, "set");
  await until(() => s.sent.length > 0, 3000);
  assert.match(s.sent[0].m.content, /timer .* fired.*check build/);
  assert.equal((s.entries.filter(([type]) => type === "infinity-timer").at(-1)?.[1] as { op: string }).op, "fired");
});

test("R-E6 session replacement replays only unacknowledged events from the new branch", async () => {
  const s = await started();
  const input = { sourceId: "job-old", kind: "job_exit", seq: 0, source: { tool: "bg_run" }, body: "finished" };
  const pending = { type: "custom", customType: "infinity-event-pending", data: input };
  const ctx = { ...s.ctx, sessionManager: { ...s.ctx.sessionManager, getBranch: () => [pending] } };
  await s.emit("session_start", { type: "session_start" }, ctx);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].m.content, /finished/);
  const ack = { type: "custom_message", customType: "infinity-event", details: s.sent[0].m.details };
  const acknowledged = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [pending, ack] } };
  await s.emit("session_start", { type: "session_start" }, acknowledged);
  assert.equal(s.sent.length, 1);
  await s.emit("session_shutdown", { type: "session_shutdown" }, acknowledged);
});

test("R-E6 recovers timer fired before outbox persistence without replaying delivered timers", async () => {
  const s = await started();
  const timer = { id: "timer-lost", kind: "sleep", setAt: 100, dueAt: 200, note: "wake" };
  const records = [
    { type: "custom", customType: "infinity-timer", data: { op: "set", timer } },
    { type: "custom", customType: "infinity-timer", data: { op: "fired", id: timer.id, at: 200 } },
  ];
  const ctx = { ...s.ctx, sessionManager: { ...s.ctx.sessionManager, getBranch: () => records } };
  await s.emit("session_start", { type: "session_start" }, ctx);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].m.content, /timer timer-lost fired\. note: wake/);
  assert.equal(s.entries.filter(([type]) => type === "infinity-event-pending").length, 1);
  const ack = { type: "custom_message", customType: "infinity-event", details: s.sent[0].m.details };
  const acknowledged = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [...records, ack] } };
  await s.emit("session_start", { type: "session_start" }, acknowledged);
  assert.equal(s.sent.length, 1);
  await s.emit("session_shutdown", { type: "session_shutdown" }, acknowledged);
});

test("R-E6 malformed pending entry does not hide a fired timer on restart", async () => {
  const s = await started();
  const timer = { id: "timer-bad-outbox", kind: "sleep", setAt: 100, dueAt: 200 };
  const records = [
    { type: "custom", customType: "infinity-timer", data: { op: "set", timer } },
    { type: "custom", customType: "infinity-timer", data: { op: "fired", id: timer.id, at: 200 } },
    { type: "custom", customType: "infinity-event-pending", data: { sourceId: timer.id, kind: "timer", seq: 0 } },
  ];
  const ctx = { ...s.ctx, sessionManager: { ...s.ctx.sessionManager, getBranch: () => records } };
  await s.emit("session_start", { type: "session_start" }, ctx);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].m.content, /timer timer-bad-outbox fired/);
  await s.emit("session_shutdown", { type: "session_shutdown" }, ctx);
});

test("R-E7 reused job ids after restart do not collide with acknowledged events", async () => {
  const f = fakePi();
  piInfinity(f.pi as never);
  const dir = mkdtempSync(join(tmpdir(), "pi-inf-job-restart-"));
  const base = fakeCtx(dir);
  const ctx = { ...base, sessionManager: { ...base.sessionManager, getSessionFile: () => join(dir, "session.jsonl") } };
  await f.emit("session_start", { type: "session_start" }, ctx);
  const first = await f.tools.get("bg_run").execute("one", { command: "echo first" }, undefined, undefined, ctx);
  assert.match(first.content[0].text, /Job j1 started/);
  await until(() => f.sent.length === 1);
  const ack = { type: "custom_message", customType: "infinity-event", details: f.sent[0].m.details };
  await f.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  rmSync(join(dir, "artifacts", "s1", "infinity", "jobs"), { recursive: true, force: true });
  const resumed = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [ack] } };
  await f.emit("session_start", { type: "session_start" }, resumed);
  const second = await f.tools.get("bg_run").execute("two", { command: "echo second" }, undefined, undefined, resumed);
  assert.match(second.content[0].text, /Job j1 started/);
  await until(() => f.sent.length === 2);
  assert.notEqual(f.sent[0].m.details.eventId, f.sent[1].m.details.eventId);
  const pending = { type: "custom", customType: "infinity-event-pending", data: f.entries.at(-1)?.[1] };
  const crashed = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [ack, pending] } };
  await f.emit("session_start", { type: "session_start" }, crashed);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].m.details.eventId, f.sent[1].m.details.eventId);
  await f.emit("session_shutdown", { type: "session_shutdown" }, crashed);
});

test("R-T1 sleep_until_event registers nothing and terminates", async () => {
  const s = await started();
  const out = await s.tools.get("sleep_until_event").execute("c", { note: "the build" }, undefined, undefined, s.ctx);
  assert.equal(out.terminate, true);
  assert.equal(s.entries.length, 0);
});

test("R-T6 sleep_until reports bad input as an error", async () => {
  const s = await started();
  await assert.rejects(
    s.tools.get("sleep_until").execute("c", { date: "2026-02-30", time: "10:00", timezone: "UTC" }, undefined, undefined, s.ctx),
  );
  await assert.rejects(
    s.tools.get("sleep_until").execute("c", { date: "2026-03-01", time: "10:00", timezone: "Nowhere/Land" }, undefined, undefined, s.ctx),
  );
});

test("R-H1 spawn_thread through the adapter rejects a wrong stack", async () => {
  const s = await started();
  await assert.rejects(
    s.tools.get("spawn_thread").execute("c", { instructions: "x", child_of: ["t-123456"] }, undefined, undefined, {
      ...s.ctx,
      executeTool: async () => assert.fail("must not launch"),
    }),
    /do not spawn the parent's threads/,
  );
});

test("R-J9 session shutdown cancels running jobs", async () => {
  const s = await started();
  await s.tools.get("bg_run").execute("c", { command: "sleep 30" }, undefined, undefined, s.ctx);
  await s.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, s.ctx);
  await until(() => s.sent.length > 0);
  assert.match(s.sent[0].m.content, /cancelled/);
});

test("B-4 B-5 subagent exit messages are shortened once the thread closed and ignored otherwise", async () => {
  const s = await started();
  const exit = (name: string) => ({
    message: { role: "custom", customType: "subagent_result", content: "long summary", details: { name } },
  });
  assert.equal(await s.emit("message_end", exit("t-123456"), s.ctx), undefined);
  assert.equal(await s.emit("message_end", { message: { role: "assistant", content: [] } }, s.ctx), undefined);
});

test("README tool tables and registered tools agree", async () => {
  const s = await started();
  const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
  const documented = new Set([...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]));
  const registered = new Set([...s.tools.keys(), "report_to_parent", "close_thread"]);
  assert.deepEqual([...registered].filter((n) => !documented.has(n)).sort(), [], "registered but undocumented");
  assert.deepEqual([...documented].filter((n) => !registered.has(n)).sort(), [], "documented but not registered");
});

function withRegistry<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
  const g = globalThis as { __pi_subagents?: unknown };
  const before = g.__pi_subagents;
  const calls: string[] = [];
  g.__pi_subagents = {
    registerAgent: (c: { name: string }) => calls.push(`register ${c.name}`),
    unregisterAgent: (n: string) => calls.push(`unregister ${n}`),
  };
  return fn(calls).finally(() => {
    g.__pi_subagents = before;
  });
}

test("R-X1 R-X3 R-X6 spawn_thread on pi-subagents returns at once and delivers the final report later", () =>
  withRegistry(async (calls) => {
    const s = await started();
    let finish: (v: unknown) => void = () => {};
    const executed: Array<{ name: string; args: any; signal?: AbortSignal }> = [];
    const ctx = {
      ...s.ctx,
      tools: [{ name: "subagent" }],
      model: { provider: "openrouter", id: "z-ai/glm-5.3" },
      executeTool: (name: string, args: unknown, options?: { signal?: AbortSignal }) => {
        executed.push({ name, args, signal: options?.signal });
        return new Promise((resolve) => (finish = resolve));
      },
    };
    const t0 = Date.now();
    const out = await s.tools
      .get("spawn_thread")
      .execute("c1", { instructions: "list files", child_of: ["root"], fresh_context: true }, undefined, undefined, ctx);
    assert.ok(Date.now() - t0 < 500);
    assert.match(out.content[0].text, /final report arrives as one \[infinity event\]/);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].name, "subagent");
    assert.deepEqual(Object.keys(executed[0].args).sort(), ["agent", "task"]);
    assert.match(executed[0].args.agent, /^thread-t-[0-9a-f]{32}$/);
    assert.match(executed[0].args.task, /list files/);
    assert.ok(executed[0].signal && !executed[0].signal.aborted);
    assert.deepEqual(calls, [`register ${executed[0].args.agent}`]);
    assert.equal(s.sent.length, 0);
    finish({ isError: false, result: { content: [{ type: "text", text: "found 3 files" }] } });
    await until(() => s.sent.length === 1);
    assert.match(s.sent[0].m.content, /Final report: found 3 files/);
    assert.deepEqual(s.sent[0].o, { triggerTurn: true, deliverAs: "steer" });
    assert.deepEqual(calls.at(-1), `unregister ${executed[0].args.agent}`);
  }));

test("R-X5 spawn_thread on pi-subagents rejects a fork request", () =>
  withRegistry(async () => {
    const s = await started();
    const ctx = { ...s.ctx, tools: [{ name: "subagent" }], executeTool: async () => assert.fail("must not launch") };
    await assert.rejects(
      s.tools.get("spawn_thread").execute("c", { instructions: "x", child_of: ["root"] }, undefined, undefined, ctx),
      /fresh_context: true/,
    );
  }));

test("R-X1 R-X2 with both subagent tools present the interactive path is used unchanged", () =>
  withRegistry(async (calls) => {
    const s = await started();
    const executed: Array<{ name: string; args: any }> = [];
    const ctx = {
      ...s.ctx,
      tools: [{ name: "subagent" }, { name: "subagent_message" }],
      executeTool: async (name: string, args: unknown) => {
        executed.push({ name, args });
        return {
          isError: false,
          result: { content: [{ type: "text", text: "started" }], details: { sessionFile: join(tmpdir(), "x-session.jsonl") } },
        };
      },
    };
    const out = await s.tools
      .get("spawn_thread")
      .execute("c", { instructions: "x", child_of: ["root"], fresh_context: true }, undefined, undefined, ctx);
    assert.match(out.content[0].text, /reports and its close arrive/);
    assert.equal(executed[0].name, "subagent");
    assert.equal(executed[0].args.agent, "thread-fresh");
    assert.match(executed[0].args.name, /^t-[0-9a-f]{32}$/);
    assert.deepEqual(calls, [], "the pi-subagents registry is untouched");
    await s.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, s.ctx);
  }));

test("R-H9 same-mode nested spawns use an alternate agent name", () => {
  for (const mode of ["fresh", "fork"]) {
    const base = `thread-${mode}`;
    assert.equal(interactiveAgentName(base, undefined), base);
    assert.equal(interactiveAgentName(base, base), `${base}-nested`);
    assert.equal(interactiveAgentName(base, `${base}-nested`), base);
  }
});

test("R-H7a interactive tool errors in details are propagated for spawn and messaging", async () => {
  const s = await started();
  let fail = true;
  const ctx = {
    ...s.ctx,
    tools: [{ name: "subagent" }, { name: "subagent_message" }],
    executeTool: async () =>
      fail
        ? { isError: false, result: { content: [{ type: "text", text: "failed" }], details: { error: "transport refused" } } }
        : {
            isError: false,
            result: { content: [{ type: "text", text: "started" }], details: { sessionFile: join(tmpdir(), "x-session.jsonl") } },
          },
  };
  await assert.rejects(
    s.tools.get("spawn_thread").execute("c", { instructions: "x", child_of: ["root"] }, undefined, undefined, ctx),
    /subagent failed: transport refused/,
  );
  fail = false;
  const out = await s.tools.get("spawn_thread").execute("c", { instructions: "x", child_of: ["root"] }, undefined, undefined, ctx);
  fail = true;
  await assert.rejects(
    s.tools.get("send_message_to_child").execute("c", { thread_id: out.details.id, message: "hello" }, undefined, undefined, ctx),
    /subagent_message failed: transport refused/,
  );
  await s.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, s.ctx);
});

test("R-X1 spawn_thread without any subagent tool says what to install", async () => {
  const s = await started();
  await assert.rejects(
    s.tools.get("spawn_thread").execute("c", { instructions: "x", child_of: ["root"], fresh_context: true }, undefined, undefined, {
      ...s.ctx,
      tools: [],
      executeTool: async () => assert.fail("no"),
    }),
    /Install pi-interactive-subagents .* or pi-subagents/,
  );
});
