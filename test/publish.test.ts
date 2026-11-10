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

test("R-H17 GitHub Packages publishes a scoped copy only when the version is missing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-github-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "log");
  const capture = join(dir, "package.json");
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const npm = spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim();
  assert.ok(npm);
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "curl"),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; output="$1"; fi; shift; done\nprintf "%s" "$METADATA" > "$output"\nprintf "%s" "$STATUS"\nexit "${CURL_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "npm"),
    '#!/bin/sh\nif [ "$1" = pack ]; then exec "$REAL_NPM" "$@"; fi\ntest -f extensions/index.ts && test -f assets/how-it-works.svg || exit 2\ncp package.json "$CAPTURE"\nprintf "%s\\n" "$*" >> "$LOG"\nexit "${NPM_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  const run = (extra: Record<string, string>) =>
    spawnSync("bash", ["scripts/publish-github.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        REAL_NPM: npm,
        LOG: log,
        CAPTURE: capture,
        NODE_AUTH_TOKEN: "test-secret-not-to-print",
        METADATA: "{}",
        ...extra,
      },
    });
  assert.equal(run({ STATUS: "200", METADATA: JSON.stringify({ versions: { [root.version]: {} } }) }).status, 0);
  assert.equal(readFileSync(log, "utf8"), "");
  for (const extra of [
    { STATUS: "404", METADATA: "" },
    { STATUS: "200", METADATA: '{"versions":{}}' },
  ]) {
    const result = run(extra);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("test-secret-not-to-print"));
    const pkg = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(pkg.name, "@alienstoearth/pi-infinity");
    assert.equal(pkg.version, root.version);
    assert.deepEqual(pkg.pi, root.pi);
  }
  assert.equal(readFileSync(log, "utf8"), "publish --ignore-scripts --registry https://npm.pkg.github.com\n".repeat(2));
  assert.notEqual(run({ STATUS: "200", METADATA: "invalid" }).status, 0);
  assert.notEqual(run({ STATUS: "200", METADATA: "{}" }).status, 0);
  assert.notEqual(run({ STATUS: "500" }).status, 0);
  assert.notEqual(run({ STATUS: "000", CURL_EXIT: "7" }).status, 0);
  assert.notEqual(run({ STATUS: "404", NPM_EXIT: "1" }).status, 0);
  assert.notEqual(run({ STATUS: "404", NODE_AUTH_TOKEN: "" }).status, 0);
  assert.equal(JSON.parse(readFileSync("package.json", "utf8")).name, root.name);
});
