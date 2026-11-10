import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "../log.ts";

export function inboxPath(sessionFile: string): string {
  return `${sessionFile}.reports.jsonl`;
}

export interface InboxLine {
  type: "report" | "closed";
  seq: number;
  text?: string;
  at: number;
}

function isInboxLine(value: unknown): value is InboxLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  return (
    (line.type === "report" || line.type === "closed") &&
    typeof line.seq === "number" &&
    Number.isSafeInteger(line.seq) &&
    line.seq >= 0 &&
    typeof line.at === "number" &&
    Number.isFinite(line.at) &&
    (line.text === undefined || typeof line.text === "string")
  );
}

export function appendInbox(file: string, line: InboxLine): void {
  const text = JSON.stringify(line);
  if (text.length > INBOX_MAX_RECORD_CHARS) throw new Error(`thread report exceeds the ${INBOX_MAX_RECORD_CHARS}-character inbox limit`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text}\n`);
}

/** R-H5. Largest number of bytes read from an inbox in a single read call. */
export const INBOX_CHUNK_BYTES = 64 * 1024;

/** R-H5. Longest inbox record kept in memory, in UTF-16 code units. Longer records are dropped. */
export const INBOX_MAX_RECORD_CHARS = 1024 * 1024;

interface SeqCounter {
  /** Bytes already counted. */
  offset: number;
  /** Nonblank records counted so far. */
  count: number;
  /** Whether the trailing partial line contains a non-whitespace character. */
  partial: boolean;
  dev?: number;
  ino?: number;
  /** Keeps multi-byte UTF-8 characters that end a read from being miscounted. */
  decoder: StringDecoder;
}

const seqCounters = new Map<string, SeqCounter>();
const SEQ_COUNTERS_MAX = 64;

function freshCounter(): SeqCounter {
  return { offset: 0, count: 0, partial: false, decoder: new StringDecoder("utf8") };
}

/** Counts lines without retaining even an arbitrarily large unterminated line. */
function countLines(counter: SeqCounter, text: string): void {
  let cursor = 0;
  for (;;) {
    const nl = text.indexOf("\n", cursor);
    const part = text.slice(cursor, nl < 0 ? undefined : nl);
    counter.partial ||= part.trim() !== "";
    if (nl < 0) return;
    if (counter.partial) counter.count++;
    counter.partial = false;
    cursor = nl + 1;
  }
}

function pruneSeqCounters(): void {
  while (seqCounters.size > SEQ_COUNTERS_MAX) {
    const oldest = seqCounters.keys().next();
    if (oldest.done) return;
    seqCounters.delete(oldest.value);
  }
}

/**
 * R-H5. Next sequence number for `file`. Only the bytes appended since the previous call are
 * read, so repeated reports stay cheap on a growing inbox. A file that shrank below the
 * counted offset, or disappeared, is counted again from zero.
 */
export function nextSeq(file: string): number {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      seqCounters.delete(file);
      return 0;
    }
    throw err;
  }
  const { size, dev, ino } = info;
  const cached = seqCounters.get(file);
  const counter = cached && size >= cached.offset && cached.dev === dev && cached.ino === ino ? cached : freshCounter();
  counter.dev = dev;
  counter.ino = ino;
  if (counter.offset < size) {
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        seqCounters.delete(file);
        return 0;
      }
      throw err;
    }
    try {
      while (counter.offset < size) {
        const len = Math.min(INBOX_CHUNK_BYTES, size - counter.offset);
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = readSync(fd, buf, 0, len, counter.offset);
        if (bytesRead <= 0) break;
        counter.offset += bytesRead;
        countLines(counter, counter.decoder.write(buf.subarray(0, bytesRead)));
      }
    } finally {
      closeSync(fd);
    }
  }
  seqCounters.set(file, counter);
  pruneSeqCounters();
  return counter.count + (counter.partial ? 1 : 0);
}

export interface InboxWatcherOptions {
  file: string;
  onLine: (line: InboxLine) => void;
  logger: Logger;
  pollMs?: number;
  /** R-H5. Bytes per read. Defaults to `INBOX_CHUNK_BYTES`. */
  chunkBytes?: number;
  /** R-H5. Longest record kept, in UTF-16 code units. Defaults to `INBOX_MAX_RECORD_CHARS`. */
  maxRecordChars?: number;
}

/**
 * R-H5. Tails a JSONL file. Uses fs.watch for latency and a poll as the fallback
 * because fs.watch drops events on some filesystems. Partial last lines wait for
 * their newline. Reads are chunked so a large inbox is never buffered whole, and a
 * record above the size cap is dropped instead of accumulating.
 */
export class InboxWatcher {
  private offset = 0;
  private carry = "";
  /** True while skipping the rest of a record that exceeded the size cap. */
  private discarding = false;
  /** Set by stop() so an in-flight pass stops emitting lines. */
  private aborted = false;
  private decoder = new StringDecoder("utf8");
  private dev?: number;
  private ino?: number;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private readonly o: InboxWatcherOptions;
  private readonly chunkBytes: number;
  private readonly maxRecordChars: number;

  constructor(o: InboxWatcherOptions) {
    this.o = o;
    this.chunkBytes = Math.max(1, Math.floor(o.chunkBytes ?? INBOX_CHUNK_BYTES));
    this.maxRecordChars = Math.max(1, Math.floor(o.maxRecordChars ?? INBOX_MAX_RECORD_CHARS));
  }

  start(): void {
    this.timer = setInterval(() => this.drain(), this.o.pollMs ?? 1000);
    // Never keep the process alive just to tail a file.
    this.timer.unref();
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      this.watcher = watch(dirname(this.o.file), () => this.drain());
      this.watcher.unref();
      this.watcher.on("error", (err) => this.o.logger.error("threads.watch", err));
    } catch (err) {
      this.o.logger.error("threads.watch", err);
    }
  }

  stop(): void {
    this.aborted = true;
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = undefined;
    this.watcher = undefined;
  }

  /**
   * R-H5. Reads the inbox in bounded chunks up to the size seen at the start of the pass.
   * Bytes appended during a pass are picked up by the next watch event or poll.
   */
  drain(): void {
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(this.o.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.o.logger.error("threads.inbox", err);
      return;
    }
    const { size, dev, ino } = info;
    if ((this.ino !== undefined && (this.ino !== ino || this.dev !== dev)) || size < this.offset) {
      this.offset = 0;
      this.carry = "";
      this.discarding = false;
      this.decoder = new StringDecoder("utf8");
    }
    this.dev = dev;
    this.ino = ino;
    this.aborted = false;
    if (this.carry.includes("\n")) this.feed("");
    if (this.aborted || size <= this.offset) return;
    let fd: number;
    try {
      fd = openSync(this.o.file, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.o.logger.error("threads.inbox", err);
      return;
    }
    try {
      while (!this.aborted && this.offset < size) {
        const len = Math.min(this.chunkBytes, size - this.offset);
        const buf = Buffer.allocUnsafe(len);
        let bytesRead: number;
        try {
          bytesRead = readSync(fd, buf, 0, len, this.offset);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.o.logger.error("threads.inbox", err);
          return;
        }
        // The file shrank under us; the next pass starts from the new size.
        if (bytesRead <= 0) return;
        this.offset += bytesRead;
        this.feed(this.decoder.write(buf.subarray(0, bytesRead)));
      }
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Splits decoded text into records, holding back a partial record until its newline. Text
   * left over when a pass aborts stays in `carry`, so the next pass resumes without a gap.
   */
  private feed(text: string): void {
    const buf = this.carry + text;
    this.carry = "";
    let cursor = 0;
    if (this.discarding) {
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      this.discarding = false;
      cursor = nl + 1;
    }
    while (cursor < buf.length && !this.aborted) {
      const nl = buf.indexOf("\n", cursor);
      if (nl < 0) break;
      const line = buf.slice(cursor, nl);
      cursor = nl + 1;
      this.emit(line);
    }
    this.carry = buf.slice(cursor);
    if (!this.discarding && this.carry.length > this.maxRecordChars) {
      this.carry = "";
      this.discarding = true;
      this.dropTooLong();
    }
  }

  private emit(line: string): void {
    if (line.trim() === "") return;
    if (line.length > this.maxRecordChars) {
      this.dropTooLong();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (err) {
      this.o.logger.error("threads.inbox", new Error(`bad inbox line ${JSON.stringify(line.slice(0, 80))}: ${(err as Error).message}`));
      return;
    }
    if (!isInboxLine(parsed)) {
      this.o.logger.error("threads.inbox", new Error(`bad inbox line ${JSON.stringify(line.slice(0, 80))}: malformed record`));
      return;
    }
    this.o.onLine(parsed);
  }

  private dropTooLong(): void {
    this.o.logger.error("threads.inbox", new Error(`inbox record longer than ${this.maxRecordChars} characters dropped`));
  }
}
