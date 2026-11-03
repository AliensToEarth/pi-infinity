# pi-infinity

An independent pi package inspired by design ideas from the
[Infinity](https://github.com/hydro-project/infinity) agent runtime. pi-infinity is an original
implementation, not Infinity itself.

An agent that waits is an agent that wastes time and tokens. pi-infinity lets pi dispatch slow
work, yield, and pick the result up later. Everything that happens in the background comes
back as one small, bounded message, and parallel edits happen in isolated checkouts instead of
your working directory.

* [Why](#why)
* [How it works](#how-it-works)
* [A short walkthrough](#a-short-walkthrough)
* [Install](#install)
* [Tools](#tools)
* [Guards](#guards)
* [Threads and sandboxes](#threads-and-sandboxes)
* [Commands](#commands)
* [Configuration](#configuration)
* [Limits](#limits)
* [Troubleshooting](#troubleshooting)
* [Development](#development)

## Why

Out of the box, a pi turn blocks while a tool runs. That produces three habits that cost time
and context:

1. The model **waits** for slow commands such as builds, test suites and dev servers.
2. The model **polls**, with `sleep` loops and `tail -f`, to find out whether something finished.
3. The model **floods its context** with unbounded output from tools.

[Infinity](https://github.com/hydro-project/infinity), a Rust agent runtime, inspired the ideas
behind pi-infinity: dispatch slow work, yield, receive results as messages, and use child threads
to keep the parent's context focused. pi-infinity adapts these ideas to pi in its own
implementation. Threads run on top of one of two subagent extensions,
[pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) or
[pi-subagents](https://github.com/amosblomqvist/pi-subagents), instead of replacing them. The full research and the reasoning behind
each feature are in [`SPEC.md`](SPEC.md).

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

### Everything is a message

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
* **Bounded.** A body over 4000 characters is saved to a file and replaced by its head, tail and
  the file path, so one noisy event cannot flood the context.
* **Interruptible.** Events are steer messages. If you type something while one is pending, your
  message goes first.

### Yielding instead of waiting

The sleep tools end the turn without another model call. The agent really stops until
something wakes it, which costs nothing while idle. The wake-up is either a timer event or
any other event or message. Timers are written to the session, so a timer set before a restart
still fires afterwards. If its time passed while pi was closed, it fires at once with a note
saying it was late.

### Guards keep bad habits out

Two small hooks make the right behavior the easy path. One refuses commands that would hold
the turn open and tells the model what to use instead. The other catches oversized tool
results and spills them to a file. Details are in [Guards](#guards).

### Threads, context and isolation

`spawn_thread` starts a child agent in its own tmux pane and returns at once. The caller picks
how much context the child gets: an empty history for independent work, or a fork of the
current conversation. With `sandbox: true` the child also gets its own git worktree or jj
workspace, so parallel edits never collide and your working directory stays untouched until
you approve a merge. See [Threads and sandboxes](#threads-and-sandboxes).

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

At no point did the model sit in a blocked tool call, run a polling loop, or read a huge log.

## Requirements

* pi 1.4 or newer
* Node 24 or newer (the tests run TypeScript directly)
* For threads: pi-interactive-subagents (needs tmux) or pi-subagents. Jobs, timers and the guards work without either.
* For sandboxes: git, or [jj](https://jj-vcs.dev)

## Install

```
git clone <this repo> && cd pi-infinity
npm install
./scripts/install.sh     # links agents/ into ~/.pi/agent/agents and runs `pi install` on this directory
```

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
| `spawn_thread` | Child thread in a tmux pane. `child_of` stack check, `fresh_context`, `sandbox`. |
| `send_message_to_child` | Message a running direct child. |
| `squash_sandbox` | Merge a child's sandbox into the caller's tree. |
| `report_to_parent` | Thread sessions only. Intermediate report. |
| `close_thread` | Thread sessions only. Final report, ends the session. |

### Background jobs in detail

* The command runs through `/bin/sh -c` in its own process group, so a cancel also reaches
  grandchildren.
* All output goes to a log file. `bg_output` reads the tail without waiting, or a byte range
  from an offset, at most 8000 bytes per call.
* `watch` takes regex sources. Matching lines are batched and sent as `job_match` events, at
  most six per minute per job by default, so a chatty stream stays cheap. Further matches are
  counted and summarized in the exit event. Set `associative: true` when every match belongs in
  the conversation and the rate limit should be off.
* `timeout_seconds` stops a job that runs too long. At most eight jobs run at once.
* A user interrupt does not cancel jobs, because background work is the point. Jobs are
  cancelled when the session ends.

## Guards

**Bash guard.** The classifier refuses `sleep 60`, `tail -f`, `watch`, endless loops and
foreground dev servers such as `npm run dev` or `python -m http.server`, with a message that
points to `bg_run` or `sleep`. It is deliberately narrow:

* Commands inside quotes are not scanned.
* Commands that are backgrounded with `&`, or wrapped in `nohup`, `setsid` or `timeout`, pass.
* Short sleeps pass. The limit is 20 seconds.

Bash calls that have no timeout get one of 180 seconds.

**Result guard.** A tool result over 40000 characters is saved to a file and replaced by its
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
  confirm first. Inside a sandboxed thread the result is committed. A conflict aborts the
  squash and leaves both sides unchanged.
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

For a corpus too large for one context, keep the original files on disk. Search or inspect
metadata first, then assign relevant, bounded file ranges to fresh-context children. Give each
child the question, paths and ranges, and ask for findings with source locations, uncertainty,
and any unread or failed portions. Track the assigned ranges and compare them with the reports
before synthesizing. Revisit missing portions and check citations against the original files.
Limit fanout and set a time and cost budget appropriate to the task. These are operator limits,
not enforced budgets; avoid delegation when a direct search is enough.

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
| `/infinity prune` | Delete merged sandbox branches after confirmation |
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

## Limits

* Running jobs end with the session. They are not resumed after a restart. Timers are.
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
* A thread starts without pi-infinity tools: run `./scripts/install.sh` again, it relinks the
  two agent definitions.
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

MIT
