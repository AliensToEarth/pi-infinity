import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

const script = "scripts/smoke-cleanup.sh";

test("R-D2 smoke cleanup retries a transient removal failure", () => {
  const output = execFileSync("bash", [
    "-c",
    'source "$1"; count=0; rm() { count=$((count + 1)); [ "$count" -ge 3 ]; }; sleep() { :; }; smoke_remove_work /tmp/example; echo "$count"',
    "bash",
    script,
  ]).toString();
  assert.equal(output.trim(), "3");
});

test("R-D2 smoke cleanup reports persistent removal failure", () => {
  const result = spawnSync("bash", [
    "-c",
    'source "$1"; rm() { return 1; }; sleep() { :; }; smoke_remove_work /tmp/example',
    "bash",
    script,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /could not remove smoke directory: \/tmp\/example/);
});
