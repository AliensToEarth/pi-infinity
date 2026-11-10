import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";

test("npm package contains the extension, thread agents, and installation documentation", () => {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
  const files = new Set<string>(pack.files.map((file: { path: string }) => file.path));
  for (const path of [
    "package.json",
    "LICENSE",
    "README.md",
    "assets/how-it-works.svg",
    "extensions/index.ts",
    "extensions/subagents-bridge.ts",
    "extensions/lib/jobs/manager.ts",
    "extensions/lib/sandbox/git.ts",
    "extensions/lib/sandbox/jj.ts",
    "extensions/lib/sandbox/types.ts",
    "extensions/lib/threads/service.ts",
    "extensions/lib/threads/protocol.ts",
    "extensions/lib/threads/inbox.ts",
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
  for (const path of files) {
    if (!path.startsWith("extensions/") || !path.endsWith(".ts")) continue;
    const source = readFileSync(path, "utf8");
    for (const [, target] of source.matchAll(/\b(?:from\s+|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const resolved = posix.normalize(posix.join(posix.dirname(path), target));
      assert.ok(files.has(resolved), `${path} imports missing package file ${resolved}`);
    }
  }
});
