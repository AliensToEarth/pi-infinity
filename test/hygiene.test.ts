import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test("source files contain no empty catch blocks", () => {
  const offenders: string[] = [];
  for (const file of walk(join(root, "extensions"))) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(file, "utf8");
    if (/catch\s*(\([^)]*\))?\s*\{\s*(\/\/[^\n]*\s*)?\}/.test(text)) offenders.push(relative(root, file));
  }
  assert.deepEqual(offenders, []);
});
