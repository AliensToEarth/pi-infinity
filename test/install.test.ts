import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { memoryLogger } from "../extensions/lib/log.ts";
import { installAgents } from "../extensions/subagents-bridge.ts";

test("R-H16 installer sets up missing packages and agents, preserves existing entries, and propagates failures", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-infinity-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const agents = join(dir, "agent");
  const log = join(dir, "calls");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "pi"),
    '#!/bin/sh\nif [ "$1" = list ]; then printf "%s\\n" "$FAKE_LIST"; exit 0; fi\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n[ "$FAKE_FAIL" != "$2" ]\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: agents,
    FAKE_LOG: log,
    FAKE_LIST: "",
    FAKE_FAIL: "",
  };
  const script = join(import.meta.dirname, "..", "scripts", "install.sh");
  const run = (extra: Record<string, string> = {}) => spawnSync("bash", [script], { env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(run().status, 0);
  assert.match(readFileSync(log, "utf8"), /install git:github.com\/amosblomqvist\/pi-interactive-subagents/);
  assert.match(readFileSync(log, "utf8"), /install .*pi-infinity/);
  assert.match(readlinkSync(join(agents, "agents", "thread-fresh.md")), /agents\/thread-fresh.md$/);
  const existing = join(agents, "agents", "thread-fork.md");
  rmSync(existing);
  writeFileSync(existing, "custom");
  writeFileSync(log, "");
  const repeated = run({ FAKE_LIST: "git:github.com/amosblomqvist/pi-interactive-subagents\ngit:github.com/AliensToEarth/pi-infinity" });
  assert.equal(repeated.status, 0);
  assert.equal(readFileSync(log, "utf8"), "");
  assert.equal(readFileSync(existing, "utf8"), "custom");
  assert.match(repeated.stderr, /not replaced/);
  assert.notEqual(run({ FAKE_FAIL: "git:github.com/amosblomqvist/pi-interactive-subagents" }).status, 0);
});

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
