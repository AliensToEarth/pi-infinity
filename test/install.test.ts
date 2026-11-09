import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryLogger } from "../extensions/lib/log.ts";
import { installAgents } from "../extensions/subagents-bridge.ts";

test("R-H15 installation links missing agents idempotently without overwriting existing entries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-infinity-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "agents"));
  const custom = join(dir, "agents", "thread-fresh.md");
  const dangling = join(dir, "agents", "thread-fork.md");
  writeFileSync(custom, "custom");
  symlinkSync("missing", dangling);
  const warnings: string[] = [];
  const logger = memoryLogger();
  installAgents(dir, logger, (message) => warnings.push(message));
  assert.equal(readFileSync(custom, "utf8"), "custom");
  assert.equal(readlinkSync(dangling), "missing");
  assert.match(readlinkSync(join(dir, "agents", "thread-fresh-nested.md")), /agents\/thread-fresh-nested.md$/);
  assert.equal(warnings.length, 2);
  installAgents(dir, logger, () => {});
});
