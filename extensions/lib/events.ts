import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log.ts";

export type EventKind = "job_exit" | "job_match" | "timer" | "child_report" | "child_closed" | "notice";

export interface EventSource {
  tool: string;
  callId?: string;
  args?: unknown;
}

export interface EventInput {
  /** Id of the thing that produced the event (job id, timer id, thread id). */
  sourceId: string;
  kind: EventKind;
  seq: number;
  source: EventSource;
  body: string;
}

export interface EventDetails {
  eventId: string;
  kind: EventKind;
  seq: number;
  synthetic: true;
  source: EventSource;
  spilledTo?: string;
}

export interface OutgoingMessage {
  customType: "infinity-event";
  content: string;
  display: true;
  details: EventDetails;
}

export interface SendOptions {
  triggerTurn: true;
  deliverAs: "steer";
}

export type Send = (message: OutgoingMessage, options: SendOptions) => void;

export const EVENT_TYPE = "infinity-event";
export const SPILL_MARKER = "[infinity: output truncated";

export function eventIdOf(input: Pick<EventInput, "sourceId" | "kind" | "seq">): string {
  return `${input.sourceId}:${input.kind}:${input.seq}`;
}

function oneLine(value: unknown, max: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function formatEventContent(input: EventInput, body: string): string {
  const call = input.source.callId ? ` (${input.source.callId})` : "";
  return [
    `[infinity event] ${input.kind} from ${input.source.tool}${call}`,
    `original_args: ${oneLine(input.source.args ?? {}, 300)}`,
    "---",
    body,
  ].join("\n");
}

export interface SpillResult {
  text: string;
  path?: string;
}

/**
 * If `text` is longer than `maxChars`, write it in full under `spillDir` and return a
 * placeholder made of the head, a marker with the path, and the tail. The caller decides
 * what to do when the write fails: the error is returned through `onError` and the text
 * is truncated without a path, so a failed write can never wedge delivery.
 */
export function spillIfLarge(
  text: string,
  spillDir: string,
  limits: { maxChars: number; headChars: number; tailChars: number },
  onError: (err: unknown) => void,
): SpillResult {
  if (text.length <= limits.maxChars) return { text };
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  const path = join(spillDir, `${hash}.txt`);
  let saved = true;
  try {
    mkdirSync(spillDir, { recursive: true });
    writeFileSync(path, text);
  } catch (err) {
    saved = false;
    onError(err);
  }
  const head = text.slice(0, limits.headChars);
  const tail = text.slice(text.length - limits.tailChars);
  const where = saved ? `full text saved to ${path}; use read with offset and limit` : "full text could not be saved";
  const marker = `${SPILL_MARKER}: ${text.length} chars total, ${where}]`;
  return { text: `${head}\n${marker}\n${tail}`, path: saved ? path : undefined };
}

export interface EmitterOptions {
  send: Send;
  spillDir: string;
  maxChars: number;
  seenCap: number;
  logger: Logger;
  notify?: (message: string) => void;
}

/**
 * One path for every asynchronous outcome. Idempotent by event id, bounded in size,
 * never throws.
 */
export class Emitter {
  private readonly seen = new Set<string>();
  private readonly opts: EmitterOptions;

  constructor(opts: EmitterOptions) {
    this.opts = opts;
  }

  /** Returns true when the event was delivered, false when it was a duplicate or failed. */
  emit(input: EventInput): boolean {
    const eventId = eventIdOf(input);
    if (this.seen.has(eventId)) return false;
    this.remember(eventId);
    try {
      const half = Math.floor(this.opts.maxChars / 4);
      const spilled = spillIfLarge(
        input.body,
        this.opts.spillDir,
        { maxChars: this.opts.maxChars, headChars: half * 2, tailChars: half },
        (err) => this.opts.logger.error("events.spill", err),
      );
      const message: OutgoingMessage = {
        customType: EVENT_TYPE,
        content: formatEventContent(input, spilled.text),
        display: true,
        details: {
          eventId,
          kind: input.kind,
          seq: input.seq,
          synthetic: true,
          source: input.source,
          ...(spilled.path ? { spilledTo: spilled.path } : {}),
        },
      };
      this.opts.send(message, { triggerTurn: true, deliverAs: "steer" });
      return true;
    } catch (err) {
      this.opts.logger.error("events.emit", err);
      this.opts.notify?.(`pi-infinity could not deliver event ${eventId}, see infinity.log`);
      return false;
    }
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.opts.seenCap) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
