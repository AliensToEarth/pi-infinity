import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryLogger } from "../extensions/lib/log.ts";
import { InboxWatcher, nextSeq } from "../extensions/lib/threads.ts";

test("R-H5 randomized byte splits preserve valid bounded records and skip corrupt ones", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-inbox-splits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "inbox.jsonl");
  let seed = 1234567;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const expected: number[] = [];
  const lines: string[] = [];
  for (let seq = 0; seq < 180; seq++) {
    if (seq % 13 === 0) lines.push("invalid json");
    const line = JSON.stringify({ type: "report", seq, at: 1, text: "🌍".repeat(random() % 90) });
    lines.push(line);
    if (line.length <= 200) expected.push(seq);
  }
  const bytes = Buffer.from(lines.join("\n") + "\n");
  const got: number[] = [];
  const watcher = new InboxWatcher({
    file,
    maxRecordChars: 200,
    chunkBytes: 17,
    logger: memoryLogger(),
    onLine: (line) => got.push(line.seq),
  });
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 1 + (random() % 101));
    appendFileSync(file, bytes.subarray(i, end));
    watcher.drain();
    i = end;
  }
  assert.deepEqual(got, expected);
  assert.equal(nextSeq(file), lines.length);
});

test("R-H5 a huge unterminated inbox fits within a bounded heap", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-inbox-stress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "inbox.jsonl");
  writeFileSync(file, "x");
  truncateSync(file, 96 * 1024 * 1024);
  const script = `
    import assert from "node:assert/strict";
    import { nextSeq, InboxWatcher } from "./extensions/lib/threads.ts";
    let errors = 0;
    assert.equal(nextSeq(process.argv[1]), 1);
    const watcher = new InboxWatcher({ file: process.argv[1], onLine: () => assert.fail("unexpected record"), logger: { error: () => errors++ } });
    watcher.drain();
    assert.equal(errors, 1);
    assert.equal(nextSeq(process.argv[1]), 1);
  `;
  const result = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", script, file], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
});
