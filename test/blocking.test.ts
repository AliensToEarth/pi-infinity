import assert from "node:assert/strict";
import { test } from "node:test";
import { blockMessage, classifyBash } from "../extensions/lib/jobs/blocking.ts";

const blocked = (cmd: string) => classifyBash(cmd, 20).blocked;

test("R-B2 long sleeps are blocked, short ones pass", () => {
  assert.equal(blocked("sleep 60"), true);
  assert.equal(blocked("sleep 20"), true);
  assert.equal(blocked("sleep 19"), false);
  assert.equal(blocked("sleep 2 && curl localhost"), false);
  assert.equal(blocked("sleep 1m"), true);
  assert.equal(blocked("sleep 0.5"), false);
  assert.equal(blocked("echo start; sleep 300; echo end"), true);
});

test("R-B2 tail follow in all spellings", () => {
  for (const c of ["tail -f log", "tail -F log", "tail --follow log", "tail -fn 20 log", "tail -n 20 -f log"])
    assert.equal(blocked(c), true, c);
  assert.equal(blocked("tail -n 20 log"), false);
});

test("R-B2 dev servers and watchers", () => {
  for (const c of [
    "npm run dev",
    "pnpm dev",
    "yarn start",
    "bun run serve",
    "vite",
    "npx vite --host",
    "next dev",
    "python3 -m http.server 8000",
    "php -S localhost:8000",
    "rails s",
    "uvicorn app:app",
    "watch ls",
    "docker compose up",
    "docker-compose up web",
    "docker compose up --detach=false",
    "docker compose up --detached",
  ]) {
    assert.equal(blocked(c), true, c);
  }
  for (const c of [
    "npm run build",
    "npm test",
    "vite build",
    "next build",
    "docker compose up -d",
    "docker compose up --detach=true",
    "docker compose ps",
    "git status",
  ])
    assert.equal(blocked(c), false, c);
});

test("R-B2 endless loops", () => {
  assert.equal(blocked("while true; do date; sleep 1; done"), true);
  assert.equal(blocked("while : ; do x; done"), true);
  assert.equal(blocked("for i in 1 2 3; do echo $i; done"), false);
});

test("R-B3 backgrounded and wrapped commands are not flagged", () => {
  assert.equal(blocked("npm run dev &"), false);
  assert.equal(blocked("nohup npm run dev > out.log 2>&1 &"), false);
  assert.equal(blocked("timeout 30 tail -f log"), false);
  assert.equal(blocked("setsid sleep 100"), false);
  assert.equal(blocked("npm run dev > out.log 2>&1"), true);
});

test("R-B3 quoted text is not scanned", () => {
  assert.equal(blocked("echo 'sleep 100'"), false);
  assert.equal(blocked('grep "tail -f" notes.txt'), false);
  assert.equal(blocked('git commit -m "run npm run dev; sleep 99"'), false);
  assert.equal(blocked("FOO=1 sleep 100"), true);
});

test("R-B5 message names the alternative and the escape hatch", () => {
  const v = classifyBash("sleep 90", 20);
  const msg = blockMessage(v, "sleep 90", "block");
  assert.match(msg, /blocked/);
  assert.match(msg, /sleep tool/);
  assert.match(msg, /bash\.guard/);
  assert.match(blockMessage(v, "sleep 90", "warn"), /notice/);
});
