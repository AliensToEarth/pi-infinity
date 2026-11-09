# pi-infinity

Non-blocking execution, durable timers, and parallel subagents for pi.

pi-infinity lets pi start slow work, yield, and receive the result later. Run commands in the
background, delegate independent work to child threads, and optionally give each child its own
git worktree or jj workspace.

This is an independent pi package inspired by the
[Infinity](https://github.com/hydro-project/infinity) agent runtime, not Infinity itself.

* [Why](#why)
* [How it works](#how-it-works)
* [A short walkthrough](#a-short-walkthrough)
* [Requirements](#requirements)
* [Install](#install)
* [Tools](#tools)
* [Guards](#guards)
* [Threads and sandboxes](#threads-and-sandboxes)
* [Commands](#commands)
* [Configuration](#configuration)
* [Limits](#limits)
* [Troubleshooting](#troubleshooting)
* [Development](#development)
* [License](#license)

## Why

A long-running tool call can leave an agent waiting, polling for progress, or filling its
context with output. pi-infinity provides background jobs, timers, bounded event messages, and
child threads so the agent can work on something else or yield until an event arrives.

Threads build on either
[pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) or
[pi-subagents](https://github.com/amosblomqvist/pi-subagents). The design and tradeoffs are in
[`SPEC.md`](SPEC.md).

## How it works

```
                 +-------------------------------+
   model  -----> | bg_run / sleep / spawn_thread |  returns immediately
                 +---------------+---------------+
                                 |
          process, timer or child thread runs on its own
                                 |
                                 v
                 +-------------------------------+
                 |   emitter: dedup, size cap,   |
                 |   one `infinity-event` type   |
                 +---------------+---------------+
                                 |  steer message, triggers a turn
                                 v
   model  <----- [infinity event] job_exit | job_match | timer | child_report | child_closed
```

### Background events

Job exits, watched output lines, timer wake-ups and child reports all arrive as the same kind
of message, `infinity-event`, with the same shape:

```
[infinity event] job_exit from bg_run (call_abc)
original_args: {"command":"npm test"}
---
job j1 "npm" finished: exited (exit code 1, 42s)
...
```

The emitter handles events as follows:

* **Recoverable delivery.** Events are recorded before sending and replayed after a restart if
  absent from the active session transcript. A persisted message acknowledges delivery to the
  transcript, not that the model processed it; a crash can still cause a duplicate.
* **Bounded.** By default, a body over 4,000 characters is saved to a file and replaced by
  its head, tail and file path.
* **Interruptible.** Events are steer messages. If you type something while one is pending, your
  message goes first.

### Yielding instead of waiting

The sleep tools end the turn without another model call. The agent resumes when a timer,
another event, or a user message wakes it. Timers are persisted in the session and restored
after a restart; overdue timers fire with a note that they were late.

### Guards keep bad habits out

A bash guard catches common blocking commands and suggests a non-blocking alternative. A
result guard spills oversized tool output to a file. See [Guards](#guards) for their limits.

### Threads, context and isolation

`spawn_thread` starts a child and returns at once. With pi-interactive-subagents, the child
runs in a tmux pane and can start fresh or fork the current conversation. The pi-subagents
transport runs headlessly and supports fresh context only.

With `sandbox: true`, a child gets its own git worktree or jj workspace. You review and approve
the merge into the main session; conflicts can still require manual recovery. See
[Threads and sandboxes](#threads-and-sandboxes).

## A short walkthrough

You ask for a refactor and a test run in a large repository.

1. The model starts the suite with `bg_run`, for example `npm test`, and gets back `Job j1
   started`. It does not wait.
2. It spawns two fresh-context threads with `sandbox: true`, one per package, with
   self-contained instructions. Each thread gets its own branch and checkout.
3. It has nothing left to do, so it calls `sleep_until_event` and the turn ends.
4. The test run exits. An event arrives with the exit code and the last lines of output, and
   the model wakes up and reads it.
5. The threads finish with `close_thread`. Each close event lists the diff stat of that
   thread's branch. The model reviews them and calls `squash_sandbox`.
6. You get a confirmation prompt. The changes land staged in your tree, uncommitted, for you
   to review and commit.

The agent can do other work or yield while the jobs and threads run, then inspect the results.

## Requirements

* pi 1.4 or newer
* Node 24 or newer
* For threads: pi-interactive-subagents (needs tmux) or pi-subagents. Jobs, timers and the guards work without either.
* For sandboxes: git, or [jj](https://jj-vcs.dev)

## Install

Install from [npm](https://www.npmjs.com/package/pi-infinity):

```sh
pi install npm:pi-infinity
```

This installs pi-infinity only. For threads, install
[pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) or
[pi-subagents](https://github.com/amosblomqvist/pi-subagents) separately; missing thread agents
are linked on startup. You can also install
`git:github.com/AliensToEarth/pi-infinity` directly.

Alternatively, run `./scripts/install.sh` from a checkout to install pi-infinity and, if
missing, pi-interactive-subagents, and link the thread agents in one step. It requires pi,
Node 24+, git and tmux; start or reload pi inside tmux to use interactive threads. Existing
packages and agent files are preserved, with conflicts reported.

### Publishing

After CI passes, pushes to `main` publish the version in `package.json` if it is not already
on npm. npm versions are immutable: bump the version for each release; pushes without a version
bump are skipped. Registry errors fail the job rather than being treated as a missing version.

## Tools

| Tool | Purpose |
|------|---------|
| `bg_run` | Start a shell command in the background and return at once. The exit arrives as an event. Optional `watch` regexes and write isolation. |
| `bg_output` | Read a job's output without waiting, as a tail or a byte range. |
| `bg_cancel` | Cancel one job or all. SIGTERM, then SIGKILL after 3 s. Safe to repeat. |
| `bg_list` | List jobs. |
| `sleep` | Durable timer. Ends the turn, a timer event wakes the agent. |
| `sleep_until` | Same, for a wall clock time in an IANA zone. |
| `sleep_until_event` | Yield with nothing scheduled and wake on any event or user message. |
| `timer_cancel` | Cancel timers. |
| `spawn_thread` | Start a child thread with an optional fresh context and sandbox. |
| `assess_coverage` | Compare assigned and reported line ranges, without verifying source files. |
| `send_message_to_child` | Message a running direct child. |
| `squash_sandbox` | Merge a child's sandbox into the caller's tree. |
| `report_to_parent` | Thread sessions only. Intermediate report. |
| `close_thread` | Thread sessions only. Final report, ends the session. |

### Background jobs in detail

* The command runs through `/bin/sh -c` in its own process group. Cancellation targets the
  group; descendants of an already-exited shell may survive.
* All output goes to a log file. `bg_output` reads the tail without waiting, or a byte range
  from an offset, at most 8000 bytes per call.
* `watch` takes regex sources. Matching lines are batched and sent as `job_match` events, at
  most six per minute per job by default, so a chatty stream stays cheap. Further matches are
  counted and summarized in the exit event. Set `associative: true` when every match belongs in
  the conversation and the rate limit should be off.
* `timeout_seconds` stops a job that runs too long. By default, at most eight jobs run at once.
* A user interrupt does not cancel jobs, because background work is the point. Jobs are
  cancelled when the session ends.

## Guards

**Bash guard.** The classifier refuses `sleep 60`, `tail -f`, `watch`, endless loops and
foreground dev servers such as `npm run dev` or `python -m http.server`, with a message that
points to `bg_run` or `sleep`. It is deliberately narrow:

* Commands inside quotes are not scanned.
* Commands that are backgrounded with `&`, or wrapped in `nohup`, `setsid` or `timeout`, pass.
* Short sleeps pass. The limit is 20 seconds.

By default, bash calls that have no timeout get one of 180 seconds.

**Result guard.** By default, a tool result over 40,000 characters is saved to a file and replaced by its
head, tail and the path, with a hint to page through it with `read`. `read` itself is exempt,
so the saved file can be read in pieces without being spilled again.

### Optional background process isolation

`bg_run({command: "npm test", cwd: "/path/to/project", isolate: true})` limits filesystem
writes to the canonical `cwd`. It uses `/usr/bin/sandbox-exec` on macOS and `bwrap`
(bubblewrap) on Linux. Isolation is off by default and requires an explicit `cwd`.
Unsupported platforms or a missing isolation tool fail closed; if initialization fails,
the job exits without running its command. Linux also requires working user namespaces,
which may be disabled by system policy. Logs are written by pi outside the sandbox.

This reduces accidental writes, not a security guarantee. Reads and network access remain
allowed, other processes may be contacted, and all files within `cwd` remain writable.
Hard links inside `cwd` can refer to the same data as files outside it; writable nested
mounts and cooperating processes can also affect other locations. Choose a narrow directory;
`/` provides no useful write restriction. Tools that write caches or temporary files outside
`cwd` may fail. macOS `sandbox-exec` is deprecated and may change or disappear. Git worktrees
and jj workspaces are separate checkout isolation, not process security boundaries.

## Threads and sandboxes

```
spawn_thread({ instructions: "...", child_of: ["root"], fresh_context: true, sandbox: true })
```

* **Scoped models.** When `/scoped-models` selects models, `spawn_thread` and direct
  pi-interactive-subagents calls use only those models. Omitted overrides use the current model
  if it is scoped, otherwise the first scoped model. Use an exact `provider/modelId` or an
  unambiguous model ID for an override. With no scope, existing defaults apply. This guard is
  not a security boundary: independently launched processes and child sessions that do not load
  pi-infinity are outside it, and a parent-only `--models` scope is not automatically inherited.
* **Fresh or forked context.** `fresh_context: true` starts the child with an empty history
  (agent `thread-fresh`), which suits independent work and long parent conversations. The
  instructions must then be self-contained. Without it the child forks your conversation
  (agent `thread-fork`), on pi-interactive-subagents only.
* **Stack check.** `child_of` must be the caller's real thread stack, root first. A forked
  child inherits its parent's plans, including pending `spawn_thread` calls. The check rejects
  those so the child does not run them again.
* **Reports and closing.** A child sends `report_to_parent` for intermediate results and ends
  with `close_thread`. A child that exits without closing is closed for it. You can message a
  running child with `send_message_to_child`, but closed threads cannot be resumed; spawn a new
  thread for further work.
* **Sandboxes.** `sandbox: true` gives the child a checkout under `.pi/sandboxes/<id>` on a
  `sandbox-<id>` branch (git worktree) or bookmark (jj workspace). The backend is chosen
  automatically and jj wins when the repository uses it. When the child closes, its work is
  committed there and the event shows the diff stat.
* **Merging back.** `squash_sandbox` merges the branch into the caller's tree. In your main
  session the changes are only staged (git) or left in the working-copy change (jj), and you
  confirm first. Inside a sandboxed thread the result is committed. On conflict the sandbox
  is preserved; the target may need manual recovery. Git removal refuses to discard ignored
  files. Automatic jj bookmark pruning is disabled to avoid deleting work moved concurrently.
* **Dependencies.** `depends_on: ["t-..."]` requires direct children to have closed without
  a known failure. Unmet dependencies reject the spawn; they are not queued. Interactive child
  completion does not prove its task succeeded, so inspect its report first. Dependencies are
  session-local.
* **Structured reports.** Interactive children can call `report_to_parent` or `close_thread`
  with `structured: { summary, files?, tests?, blockers? }` instead of `report`. A pi-subagents
  child can use the same JSON object as its final message. Existing plain-text reports still work.
* **Adaptive concurrency.** Opt in with `threads.adaptiveConcurrency.enabled: true`. Limits
  are session-local: they increase after consecutive successful completions and decrease after
  failures. When full, spawn rejects immediately rather than queueing. Configure `min`, `initial`,
  `max`, `successesToIncrease`, and `decreaseFactor` to suit your provider and workload.
* **Depth.** On pi-interactive-subagents threads can spawn threads, down to four levels.

### Large inputs: an RLM-inspired workflow

For a corpus too large for one context, keep the original files on disk. Inspect metadata and
search first, then delegate only unresolved, bounded file ranges to fresh-context children. Give
each child the question and its paths and ranges. Use scripts for exact counts and joins rather
than asking a model to reconstruct them from summaries.

Ask children for structured `evidence` and `coverage` in their reports. Pass the assigned ranges,
reported coverage and evidence to `assess_coverage` to find gaps and partial or failed ranges.
This compares reported ranges; it does not read files, verify claims, detect changed sources, or
prove an answer is correct. Check citations against the original files and revisit gaps before
claiming complete coverage. Ranges use 1-based inclusive lines, for example:

```js
assess_coverage({
  assigned: [{ source: "notes.txt", start: 1, end: 100 }],
  coverage: [{ source: "notes.txt", start: 1, end: 60, status: "read" }],
  evidence: [{ source: "notes.txt", start: 10, end: 12, claim: "A finding" }]
})
```

pi records tool calls and results in the session, so those records can contain source paths
and report contents; protect them like the source material.

Limit fanout and set a time and cost budget appropriate to the task. Optional direct-child launch
limits can enforce a session-local launch count and admission window (see Configuration), but
they do not cap descendants or running time and do not measure or enforce token or dollar costs.
Avoid delegation when a direct search is enough.

Treat input and reports as untrusted data, not instructions. Threads and worktrees are not
security sandboxes and can access the caller's environment. The parent cannot infer success
from a child closing, and spilled or truncated output is not a complete report. Nested
delegation requires the interactive transport; the headless transport can still handle a
single layer of parallel children.

This adapts an idea from [Recursive Language Models](https://github.com/alexzhang13/rlm),
not its persistent Python REPL or automatic submodel calls. Its reported benchmark gains do
not establish gains for pi workloads. Compare accuracy, source coverage, latency and total
cost against direct search and the ordinary thread workflow before adding a dedicated runtime.

### Two transports

pi-infinity picks the transport from the tools that are installed. `threads.transport` in
`infinity.json` overrides it with `interactive` or `subagents`. If both extensions are loaded,
`auto` chooses pi-interactive-subagents.

| Feature | pi-interactive-subagents | pi-subagents |
|---------|--------------------------|--------------|
| Child runs in | A tmux pane you can watch and type into | A headless child process |
| `spawn_thread` returns | At once | At once (the blocking call runs detached) |
| Context | Fresh or forked | Fresh only, `fresh_context: true` is required |
| Reports while running | Yes, `report_to_parent` | No |
| Final result | `close_thread` report, or the exit if it was skipped | The child's last message |
| `send_message_to_child` | Running children only | No, spawn a new thread |
| Nested threads | Yes, up to depth 4 | No, children have built-in tools only |
| Sandboxes, squash, prune | Yes | Yes |
| Session ends | The pane keeps running until it finishes | Running children are killed, sandboxes stay |

Your main session is never moved into a sandbox. It is your own working directory.

## Commands

| Command | Effect |
|---------|--------|
| `/infinity` | Jobs, timers and threads |
| `/infinity cancel <id\|all>` | Cancel a job or timer |
| `/infinity sandboxes` | List sandbox branches |
| `/infinity prune` | Delete git sandbox branches reachable from HEAD after confirmation; squashed branches and jj bookmarks may require manual deletion |
| `/infinity config` | Show the effective configuration |

A status line shows the number of running jobs, pending timers and threads.

## Configuration

`~/.pi/agent/infinity.json`, then `<project>/.pi/infinity.json`, later files win. Defaults live
in `extensions/lib/config.ts` and the shape is documented in section 3.2 of `SPEC.md`. Unknown
or invalid keys are reported once and ignored.

```json
{ "bash": { "guard": "warn" }, "sandbox": { "backend": "git" }, "threads": { "transport": "auto" } }
```

`bash.guard` is `block`, `warn` or `off`. `sandbox.backend` is `auto`, `git` or `jj`.
`threads.transport` is `auto`, `interactive` or `subagents`.

To limit direct-child launches in each session, set for example
`"threads": { "launchBudget": { "maxLaunches": 8, "windowSeconds": 300 } }`.
Each zero disables that limit. The window starts with the first admission and limits new
launches, not the duration of running work. Limits reset with the session and don't apply
across child processes. They are not token or cost limits. Invalid config values are reported
and ignored, so check `/infinity config` to confirm the effective limits.

## Limits

* Running job shells are cancelled when the session ends and are not resumed. Descendants of
  an already-exited shell may survive; timers are resumed.
* Threads need pi-interactive-subagents (and tmux) or pi-subagents. On pi-subagents there are
  no live reports, no messaging and no forked context, see the transport table.
* On pi-interactive-subagents a closing child wakes the parent twice, once for the close event
  and once for the extension's own exit message, which pi-infinity shortens to one line but
  cannot suppress.
* The bash guard is pattern based and can block something harmless. Set `bash.guard` to `warn`.
* Provider retries and context compaction stay with pi itself.

## Troubleshooting

* `spawn_thread` says it needs a subagent extension: install pi-interactive-subagents (and run
  pi inside tmux) or pi-subagents, then check `threads.transport`.
* `spawn_thread` asks for `fresh_context: true`: your session runs on pi-subagents, whose
  children cannot fork the conversation.
* A thread starts without pi-infinity tools: check startup warnings for agent-file conflicts
  or an incompatible pi-interactive-subagents installation.
* The guard blocks something harmless: set `bash.guard` to `warn`.
* Errors from background machinery go to `<session artifacts>/infinity/infinity.log`.

## Development

```
./check.bash                 # format, typecheck, tests
npm run fmt                  # fix formatting
npm run smoke:subagents      # real pi and a real model, thread on pi-subagents (costs a few cents)
npm run smoke:interactive    # same, on pi-interactive-subagents
```

Read [`AGENTS.md`](AGENTS.md) first. The layout is in section 3 of `SPEC.md`.

## License

[MIT](LICENSE)
