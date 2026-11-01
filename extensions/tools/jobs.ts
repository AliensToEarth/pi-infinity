import { resolve } from "node:path";
import { Type } from "typebox";
import type { Job } from "../lib/jobs.ts";
import type { Runtime } from "../runtime.ts";
import { tool, type ToolDef } from "./types.ts";

function describeJob(j: Job): string {
  const age = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
  return `${j.id} "${j.name}" ${j.status} ${age}s lines=${j.lines} log=${j.logPath}`;
}

export function jobTools(rt: () => Runtime): ToolDef[] {
  const bgRun = tool({
    name: "bg_run",
    label: "Background run",
    description:
      "Run a shell command in the background and return at once. Output goes to a log file. When the process ends you receive one [infinity event] message with the exit code and the last lines. " +
      "Use it for builds, tests, servers, installs and anything that may take more than a few seconds. After starting it, end your turn or do independent work. Never poll, wait or tail it. " +
      "Optional watch: regex sources; matching lines are batched into events (rate limited) so you can react to a ready line. Jobs end when the session ends.",
    promptSnippet: "Run a command in the background, results arrive later as [infinity event] messages.",
    promptGuidelines: [
      "Never wait on slow work. Start it with bg_run, then end your turn or do independent work; the result arrives as an [infinity event] message.",
      "Do not poll with wait loops or tail -f. Do not guess the result of work you started and have not seen reported.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command, run with /bin/sh -c" }),
      name: Type.Optional(Type.String({ description: "Short label shown in events and lists" })),
      cwd: Type.Optional(Type.String({ description: "Working directory, default is the session directory" })),
      watch: Type.Optional(Type.Array(Type.String(), { description: "JS regex sources. Matching lines produce job_match events" })),
      associative: Type.Optional(Type.Boolean({ description: "Deliver every matching batch without the rate limit. Default false" })),
      timeout_seconds: Type.Optional(Type.Number({ description: "Stop the job after this many seconds. Default none" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const r = rt();
      const job = r.jobs.start({
        command: params.command,
        name: params.name,
        cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd,
        watch: params.watch,
        associative: params.associative,
        timeoutSeconds: params.timeout_seconds,
        callId: toolCallId,
      });
      const text =
        `Job ${job.id} started in the background (pid ${job.pid ?? "unknown"}). Log: ${job.logPath}\n` +
        "You will get an [infinity event] message when it exits. Do not poll. End your turn or work on something independent.";
      return { content: [{ type: "text", text }], details: { id: job.id, pid: job.pid, logPath: job.logPath } };
    },
  });

  const bgOutput = tool({
    name: "bg_output",
    label: "Background output",
    description:
      "Read output of a background job without waiting. Default is the last lines. With since, read a byte range of the log from that offset and get the next offset back. Bounded to 8000 bytes per call.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id such as j1" }),
      tail: Type.Optional(Type.Integer({ minimum: 1, description: "Number of last lines, default 40" })),
      since: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset into the log" })),
    }),
    async execute(_id, params) {
      const out = rt().jobs.output(params.id, { tail: params.tail, since: params.since });
      const text = `status: ${out.status}, next offset: ${out.nextOffset}\n${out.text === "" ? "(no output yet)" : out.text}`;
      return { content: [{ type: "text", text }], details: { id: params.id, nextOffset: out.nextOffset, status: out.status } };
    },
  });

  const bgCancel = tool({
    name: "bg_cancel",
    label: "Background cancel",
    description:
      "Cancel a background job (SIGTERM to its process group, SIGKILL after 3 s). Returns at once and is safe to repeat. The exit event still arrives. Use all: true to cancel every running job.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job id" })),
      all: Type.Optional(Type.Boolean({ description: "Cancel every running job" })),
    }),
    async execute(_id, params) {
      const r = rt();
      if (params.all) {
        const n = r.jobs.cancelAll();
        return {
          content: [{ type: "text", text: `Cancel requested for ${n} running job${n === 1 ? "" : "s"}.` }],
          details: { cancelled: n },
        };
      }
      if (!params.id) throw new Error("pass id or all: true");
      const { job, alreadyFinished } = r.jobs.cancel(params.id);
      const text = alreadyFinished
        ? `Job ${job.id} had already finished (${job.status}).`
        : `Cancel requested for job ${job.id}. Its exit event will follow.`;
      return { content: [{ type: "text", text }], details: { id: job.id, alreadyFinished } };
    },
  });

  const bgList = tool({
    name: "bg_list",
    label: "Background list",
    description: "List background jobs of this session with status, age and log path.",
    parameters: Type.Object({}),
    async execute() {
      const jobs = rt().jobs.list();
      const text = jobs.length === 0 ? "No background jobs." : jobs.map(describeJob).join("\n");
      return { content: [{ type: "text", text }], details: { count: jobs.length } };
    },
  });

  return [bgRun, bgOutput, bgCancel, bgList];
}
