import { Type } from "typebox";
import { zonedTimeToUtcMs } from "../lib/timers.ts";
import type { Runtime } from "../runtime.ts";
import { tool, type ToolDef } from "./types.ts";

function clock(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const YIELD_NOTE = "Your turn ends now. A [infinity event] timer message will wake you. Do not poll or call other tools to wait.";
const EVENT_NOTE =
  "Your turn ends now. You wake on the next [infinity event] message or user message. Do not poll or call other tools to wait.";

export function timerTools(rt: () => Runtime): ToolDef[] {
  const sleep = tool({
    name: "sleep",
    label: "Sleep",
    description:
      "Wait for a fixed time without blocking. Sets a durable timer and ends your turn; a [infinity event] timer message wakes you when it fires, even after a restart. " +
      "Use it instead of sleep loops in bash. Other work and user messages are handled normally while the timer runs.",
    promptSnippet: "Set a timer and yield; a timer event wakes you.",
    promptGuidelines: [
      "To wait for time to pass, use sleep or sleep_until. To wait for jobs, threads or the user, use sleep_until_event. Never loop on a bash sleep.",
    ],
    parameters: Type.Object({
      seconds: Type.Number({ minimum: 1, maximum: 604800, description: "Delay in seconds, 1 to 604800" }),
      note: Type.Optional(Type.String({ description: "Reminder that comes back with the wake-up" })),
    }),
    async execute(_id, params) {
      const t = rt().timers.schedule(params.seconds * 1000, params.note, "sleep");
      return {
        content: [{ type: "text", text: `Timer ${t.id} set for ${clock(t.dueAt)}. ${YIELD_NOTE}` }],
        details: { id: t.id, dueAt: t.dueAt },
        terminate: true,
      };
    },
  });

  const sleepUntil = tool({
    name: "sleep_until",
    label: "Sleep until",
    description:
      "Wait until a wall clock time in an IANA time zone, for example 09:30 America/New_York. Same behavior as sleep. A time in the past fires at once.",
    parameters: Type.Object({
      date: Type.String({ description: "YYYY-MM-DD" }),
      time: Type.String({ description: "HH:MM or HH:MM:SS, 24 hour" }),
      timezone: Type.String({ description: "IANA zone such as Europe/London" }),
      note: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const dueAt = zonedTimeToUtcMs(params.date, params.time, params.timezone);
      const t = rt().timers.scheduleAt(dueAt, params.note, "sleep_until");
      return {
        content: [{ type: "text", text: `Timer ${t.id} set for ${clock(t.dueAt)}. ${YIELD_NOTE}` }],
        details: { id: t.id, dueAt: t.dueAt },
        terminate: true,
      };
    },
  });

  const sleepUntilEvent = tool({
    name: "sleep_until_event",
    label: "Wait for event",
    description:
      "Yield with nothing scheduled. You wake when a background job, thread, timer or the user sends a message. Use it after starting work you are waiting on when you have nothing else to do.",
    parameters: Type.Object({ note: Type.Optional(Type.String({ description: "What you are waiting for" })) }),
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: `Waiting${params.note ? ` (${params.note})` : ""}. ${EVENT_NOTE}` }],
        details: {},
        terminate: true,
      };
    },
  });

  const timerCancel = tool({
    name: "timer_cancel",
    label: "Cancel timer",
    description: "Cancel a pending timer by id, or all pending timers with all: true. Safe to repeat.",
    parameters: Type.Object({ id: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      const r = rt();
      if (params.all) {
        const n = r.timers.cancelAll();
        return { content: [{ type: "text", text: `Cancelled ${n} timer${n === 1 ? "" : "s"}.` }], details: { cancelled: n } };
      }
      if (!params.id) throw new Error("pass id or all: true");
      const ok = r.timers.cancel(params.id);
      return {
        content: [{ type: "text", text: ok ? `Timer ${params.id} cancelled.` : `Timer ${params.id} is not pending.` }],
        details: { cancelled: ok ? 1 : 0 },
      };
    },
  });

  return [sleep, sleepUntil, sleepUntilEvent, timerCancel];
}
