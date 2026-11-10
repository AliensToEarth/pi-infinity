import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendInbox, inboxPath } from "../extensions/lib/threads/inbox.ts";
import { createRuntime } from "../extensions/runtime.ts";

test("R-H8 runtime replacement restores only unacknowledged child reports on its session branch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-runtime-recovery-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const branch: Array<Record<string, unknown>> = [];
  const messages: Array<{ content: string; details: unknown }> = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: (message: { content: string; details: unknown }) => {
      messages.push(message);
      branch.push({ type: "custom_message", customType: "infinity-event", details: message.details });
    },
  };
  const context = {
    cwd: dir,
    hasUI: false,
    sessionManager: {
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionDir: () => dir,
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
  };
  const runtimes: ReturnType<typeof createRuntime>[] = [];
  const start = () => {
    const runtime = createRuntime(pi as never, context as never);
    runtimes.push(runtime);
    return runtime;
  };
  t.after(() => {
    for (const runtime of runtimes) runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const first = start();
  const child = join(dir, "child.jsonl");
  const { id } = await first.threads!.spawn(
    { instructions: "work", child_of: ["root"] },
    { cwd: dir, callId: "origin", launch: async () => ({ sessionFile: child }), sendToChild: async () => {} },
  );
  appendInbox(inboxPath(child), { type: "report", seq: 0, text: "before", at: 1 });
  first.threads!.drainAll();
  assert.equal(messages.length, 1);
  first.dispose();
  appendInbox(inboxPath(child), { type: "report", seq: 1, text: "while away", at: 2 });
  appendInbox(inboxPath(child), { type: "closed", seq: 2, text: "finished", at: 3 });
  const resumed = start();
  assert.equal(resumed.threads!.list()[0]?.id, id);
  resumed.threads!.drainAll();
  assert.equal(messages.length, 3);
  assert.match(messages[1].content, /while away/);
  assert.match(messages[2].content, /finished/);
  assert.equal(resumed.threads!.runningCount(), 0);
});
