import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("R-H17 publish only missing versions and propagate registry and publish failures", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "curl"), '#!/bin/sh\nprintf "%s" "$STATUS"\nexit "${CURL_EXIT:-0}"\n', { mode: 0o755 });
  writeFileSync(join(dir, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LOG"\nexit "${NPM_EXIT:-0}"\n', { mode: 0o755 });
  const run = (extra: Record<string, string>) =>
    spawnSync("bash", ["scripts/publish.sh"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOG: log, ...extra },
    });
  assert.equal(run({ STATUS: "200" }).status, 0);
  assert.equal(readFileSync(log, "utf8"), "");
  assert.equal(run({ STATUS: "404" }).status, 0);
  assert.equal(readFileSync(log, "utf8"), "publish --access public\n");
  assert.notEqual(run({ STATUS: "500" }).status, 0);
  assert.notEqual(run({ STATUS: "000", CURL_EXIT: "7" }).status, 0);
  assert.notEqual(run({ STATUS: "404", NPM_EXIT: "1" }).status, 0);
});
