import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { JobManager } from "../extensions/lib/jobs/manager.ts";
import { memoryLogger } from "../extensions/lib/log.ts";
import { isolatedCommand } from "../extensions/lib/jobs/isolation.ts";

test("R-J13 unsupported platforms fail closed", () => {
  assert.throws(() => isolatedCommand("echo unsafe", tmpdir(), "freebsd"), /unavailable/);
});

test("R-J13 Linux requires bwrap and constructs a read-only root with writable canonical cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bwrap-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = root;
    assert.throws(() => isolatedCommand("unsafe", root, "linux"), /requires executable bwrap/);
    const executable = join(root, "bwrap");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const alias = join(root, "alias");
    symlinkSync(root, alias);
    const directory = realpathSync(root);
    assert.deepEqual(isolatedCommand("echo ok", alias, "linux"), {
      executable,
      args: ["--ro-bind", "/", "/", "--bind", directory, directory, "--chdir", directory, "--", "/bin/sh", "-c", "echo ok"],
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("R-J13 Linux bwrap confines writes and preserves reads", { skip: process.platform !== "linux" }, (t) => {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { encoding: "utf8" });
  if (probe.status !== 0) {
    if (process.env.REQUIRE_LINUX_ISOLATION === "1") assert.fail(`bwrap setup failed: ${probe.error ?? probe.stderr}`);
    t.skip(`bwrap or namespaces unavailable: ${probe.error ?? probe.stderr}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "pi-bwrap-live-"));
  try {
    const cwd = join(root, "work");
    const outside = join(root, "outside");
    const alias = join(root, "alias");
    mkdirSync(cwd);
    writeFileSync(outside, "readable");
    symlinkSync(cwd, alias);
    symlinkSync(outside, join(cwd, "escape"));
    const command = "printf ok > inside; cat ../outside; if printf bad > escape; then exit 9; fi; if printf bad > ../new; then exit 10; fi";
    const isolated = isolatedCommand(command, alias);
    const result = spawnSync(isolated.executable, isolated.args, { cwd: alias, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "readable");
    assert.equal(readFileSync(join(cwd, "inside"), "utf8"), "ok");
    assert.equal(readFileSync(outside, "utf8"), "readable");
    assert.equal(existsSync(join(root, "new")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R-J13 Linux namespace setup failure never falls back to the shell", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bwrap-fail-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(root, "bwrap"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    process.env.PATH = root;
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
    const job = mgr.start({ command: "touch marker", cwd: root, isolate: true });
    await exited;
    assert.equal(job.exitCode, 42);
    assert.equal(existsSync(join(root, "marker")), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
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
