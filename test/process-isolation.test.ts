import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { JobManager } from "../extensions/lib/jobs.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { isolatedCommand } from "../extensions/lib/process-isolation.ts";

test("R-J13 unsupported platforms fail closed", () => {
  assert.throws(() => isolatedCommand("echo unsafe", tmpdir(), "linux"), /unavailable/);
});

test("R-J13 invalid macOS working directories fail before running the command", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-isolation-invalid-"));
  try {
    const file = join(root, "file");
    const marker = join(root, "marker");
    const control = join(root, "bad\nname");
    writeFileSync(file, "not a directory");
    mkdirSync(control);
    const mgr = new JobManager({ emit: () => {}, logDir: join(root, "logs"), config: DEFAULT_CONFIG.jobs, logger: memoryLogger() });
    for (const cwd of [file, join(root, "missing"), control]) {
      assert.throws(() => mgr.start({ command: `touch '${marker}'`, cwd, isolate: true }));
    }
    assert.equal(existsSync(marker), false);
    assert.deepEqual(mgr.list(), []);
    assert.equal(existsSync(join(root, "logs")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "R-J13 macOS denies sibling and symlink-directory writes with escaped cwd",
  { skip: process.platform !== "darwin", timeout: 5000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-isolation-escape-"));
    const cwd = join(root, 'work\\\\"quoted');
    const sibling = `${cwd}-sibling`;
    mkdirSync(cwd);
    mkdirSync(sibling);
    symlinkSync(sibling, join(cwd, "escape"));
    try {
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const mgr = new JobManager({
        emit: (event) => {
          if (event.kind === "job_exit") resolveExit();
        },
        logDir: join(root, "logs"),
        config: DEFAULT_CONFIG.jobs,
        logger: memoryLogger(),
      });
      const job = mgr.start({
        cwd,
        isolate: true,
        command:
          "printf allowed > inside; if printf bad > escape/link; then exit 9; fi; if printf bad > '../work\\\\\"quoted-sibling/direct'; then exit 10; fi",
      });
      await exited;
      assert.equal(job.exitCode, 0, readFileSync(job.logPath, "utf8"));
      assert.equal(readFileSync(join(cwd, "inside"), "utf8"), "allowed");
      assert.equal(existsSync(join(sibling, "link")), false);
      assert.equal(existsSync(join(sibling, "direct")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "R-J13 macOS restricts writes outside canonical cwd while preserving output and reads",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-isolation-"));
    const cwd = join(root, 'work "quoted"');
    const outside = join(root, "outside");
    const link = join(root, "alias");
    mkdirSync(cwd);
    writeFileSync(outside, "readable");
    symlinkSync(cwd, link);
    symlinkSync(outside, join(cwd, "escape"));
    try {
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const mgr = new JobManager({
        emit: (event) => {
          if (event.kind === "job_exit") resolveExit();
        },
        logDir: join(root, "logs"),
        config: DEFAULT_CONFIG.jobs,
        logger: memoryLogger(),
      });
      const job = mgr.start({
        cwd: link,
        isolate: true,
        command:
          "printf ok > inside; cat ../outside; printf error >&2; if printf bad > escape; then exit 9; fi; if printf bad > ../new; then exit 10; fi; test ! -t 0",
      });
      await exited;
      assert.equal(job.exitCode, 0);
      assert.equal(readFileSync(join(cwd, "inside"), "utf8"), "ok");
      assert.equal(readFileSync(outside, "utf8"), "readable");
      assert.equal(existsSync(join(root, "new")), false);
      assert.match(readFileSync(job.logPath, "utf8"), /readable/);
      assert.match(readFileSync(job.logPath, "utf8"), /error/);
      assert.ok(realpathSync(link).endsWith('work "quoted"'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
