import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("npm package contains the extension, thread agents, and installation documentation", () => {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
  const files = new Set<string>(pack.files.map((file: { path: string }) => file.path));
  for (const path of [
    "package.json",
    "LICENSE",
    "README.md",
    "extensions/index.ts",
    "extensions/subagents-bridge.ts",
    "agents/thread-fresh.md",
    "agents/thread-fork.md",
    "agents/thread-fresh-nested.md",
    "agents/thread-fork-nested.md",
    "agents/blocking/thread-blocking.md",
    "scripts/install.sh",
  ]) {
    assert.ok(files.has(path), `npm package missing ${path}`);
  }
  assert.ok(![...files].some((path) => path.startsWith("test/") || path.includes("node_modules/")));
});
