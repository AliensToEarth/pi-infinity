# pi-infinity: specification

Status: v1.0 draft, written after research (Sprint 0). Implementation follows in sprints 1 to 6 (section 9).

pi-infinity is a pi package (one extension plus two agent definitions) that brings the
design practices of the Infinity agent runtime (hydro-project/infinity) into pi, and
builds on the tmux sub-agent machinery of pi-interactive-subagents instead of replacing it.

## 1. Research

### 1.1 Sources read

1. hydro-project/infinity, README, AGENTS.md, and the docs tree: runtime overview and
   architecture, built-in tools, threading, low-level completion loop and history manager,
   Infinity Code (jj and git sandboxes, background agents), and the RAP specification
   (what-is-rap, subscription events, tool cancellation, thread closure).
2. amosblomqvist/pi-interactive-subagents (fork of HazAT/pi-interactive-subagents), README
   and source, already installed here as a global extension. It gives us: async `subagent`
   spawning in tmux panes, steer-message result delivery, name registry and resume,
   whitelist-only tool access, `session-mode` (standalone, lineage-only, fork),
   `registerToolExtension` for child tool injection.
3. pi 1.4.0 extension documentation and type declarations (events, `sendMessage`,
   `terminate`, `executeTool`, `tool_result`, `session_shutdown`).

### 1.2 What Infinity actually teaches

Infinity is a Rust runtime, so most of it cannot be copied. The transferable part is a set
of design rules. We extracted these:

| # | Infinity practice | Where it comes from |
|---|-------------------|---------------------|
| P1 | An execution slice never blocks on anything external. Slow work is dispatched, the agent yields, and the result comes back later. | architecture.md |
| P2 | Everything is a message. Tool results, user text, timers, child reports and events share one input type with a `synthetic` tag. | architecture.md |
| P3 | Turn durability. A tool call is persisted before it is dispatched. Redelivered messages are deduplicated by stable id. | architecture.md, history-manager.md |
| P4 | Sleep tools: `sleep`, `sleep_until`, `sleep_until_event_or_input`. Passive and interruptible. Timers are durable. | built-in-tools.md |
| P5 | Subscriptions: long-lived event streams against one call. Events are either threaded (isolated, parent sees a report) or associative (inline). Noisy streams stay out of the parent context. | subscription-events.md |
| P6 | Threads: `spawn_thread`, `report_to_parent`, `close_thread`, `send_message_to_child`. The `child_of` stack check stops a child from running its parent's plans. `fresh_context` gives an empty history. | threading.md |
| P7 | Cancellation and closure are advisory, best effort, idempotent, never block, and never retried. | tool-cancellation.md, thread-closure.md |
| P8 | Oversized input must never wedge a thread. The body is replaced with a placeholder and the loop continues. | completion-loop.md |
| P9 | Provider errors are classified (transient, throttled, fatal, overflow). A config error must not become a retry loop. | completion-loop.md, SSO fix in the git log |
| P10 | Sandboxed editing. Each thread works in an isolated jj workspace or git worktree on a `sandbox-<id>` branch. Finished children are squashed into the parent. The user's working copy is never touched. | infinity-code docs |
| P11 | Unknown tool names get an injected error result and the loop continues. | architecture.md |
| P12 | Development hygiene. Conventional Commits, `check.bash` as the single gate, suppressed `cargo fmt` diff output so agents do not hand-apply formatting, never ignore `Err`, `.expect("bug: ...")` messages, doc examples compiled as tests, THIRD-PARTY license gate. | AGENTS.md, check.bash, infinity-mdtests |
| P13 | Background sessions and headless tasks. | background-agents.md |
| P14 | Context hygiene. Child threads exist mostly to keep the parent's context clean. | threading.md |

### 1.3 Mapping to pi

Decision key: ADOPT (implement here), DELEGATE (pi or pi-interactive-subagents already does
it, we only configure or wrap), SKIP (does not fit, reason given).

| Practice | Decision | Notes |
|----------|----------|-------|
| P1 | ADOPT | `bg_run`, `bg_output`, `bg_cancel`, `bg_list`; bash guard that refuses blocking commands; default bash timeout; prompt guidance. |
| P2 | ADOPT | One custom message type, `infinity-event`, used by every module. Same rendering, same dedup, same size cap. |
| P3 | ADOPT (partly) | pi persists sessions itself. We add idempotent event delivery (stable ids, bounded seen-set) and durable timers that survive restart via `appendEntry`. |
| P4 | ADOPT | `sleep`, `sleep_until`, `sleep_until_event`, `timer_cancel`. Results use `terminate: true` so the agent really yields without another model call. |
| P5 | ADOPT | `bg_run` with `watch` patterns. Matches are batched and rate limited. Default delivery is a digest, inline delivery is opt in (`associative`). |
| P6 | ADOPT on top of subagents | `spawn_thread`, `report_to_parent`, `close_thread`, `send_message_to_child`, built on the `subagent` tools via `ctx.executeTool`. `fresh_context` maps to two bundled agent definitions. |
| P7 | ADOPT | Job cancel is SIGTERM then SIGKILL on the process group, idempotent, never blocks. Session shutdown cancels every job and closes every thread, best effort. |
| P8 | ADOPT | `tool_result` guard. Results above a threshold are spilled to a file and replaced by head, tail and a path. |
| P9 | DELEGATE | pi core owns provider retry and compaction. Documented as a non-goal so nobody duplicates it. |
| P10 | ADOPT, git and jj | `spawn_thread({sandbox:true})` creates a git worktree or jj workspace and a `sandbox-<id>` branch or bookmark. `squash_sandbox` merges a finished child. Root session is the user's own working directory and is never auto-modified. |
| P11 | DELEGATE | pi already returns an error result for unknown tools. |
| P12 | ADOPT | `AGENTS.md` with Conventional Commits, `check.bash` as the only gate with quiet formatting failures, errors never ignored, `bug:` messages, CI that runs the gate. |
| P13 | DELEGATE | pi print mode, tmux, and subagents cover it. |
| P14 | ADOPT | Prompt guidance steers the model toward `fresh_context` threads for independent work and toward rate limited watch delivery for noisy streams. |

### 1.4 Constraints from the local environment

* pi 1.4.0 provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-tui` and `typebox` to extensions. Nothing else is bundled.
* Node 26 runs TypeScript directly (type stripping), so tests need no build step.
* Sandboxes use a backend interface with two implementations, git worktrees and jj
  workspaces. jj 0.46 is used for development and tests.

## 2. Product definition

### 2.1 Problem

pi already runs tools one at a time and blocks the turn while a tool runs. The model has
three bad habits that follow from that: it waits for slow commands, it polls with `sleep`
loops, and it dumps unbounded output into context. pi-interactive-subagents fixes the
spawning side but offers no shared conventions for events, timers, background commands,
thread hierarchy or isolated workspaces. pi-infinity supplies those, using Infinity's rules.

### 2.2 Goals

G1. A model can start slow work and yield in one turn, and always gets the result later as a
    single, bounded, deduplicated message.
G2. A model can sleep and wait for events without a polling loop. Timers survive a restart.
G3. A model can spawn child threads with explicit context control, receive their reports,
    and close them. A child cannot replay its parent's spawn plan.
G4. Parallel code changes happen in isolated git worktrees. The user's working directory is
    only touched when the user approves.
G5. Nothing the extension does can wedge a session: output is bounded, cancellation is
    best effort, errors are logged and surfaced, never swallowed.
G6. The repo follows the same hygiene Infinity does: one gate script, tests, tested docs.

### 2.3 Non-goals

* Replacing pi's provider layer, retry logic or compaction (P9).
* Replacing pi-interactive-subagents. We depend on it for thread transport.
* A serverless runtime, queues, a database, RAP servers. pi is a resident process.
* jj sandboxes in v1 (backlog B1).
* Surviving a pi restart with live background processes. Jobs die with the session (R-J9).

### 2.4 Users

* U1, the pi user who wants an agent that keeps working while builds run.
* U2, the model itself, which reads tool descriptions and prompt guidance. Descriptions are
  part of the product and are tested for key phrases.

## 3. Architecture

```
extensions/
  index.ts            wiring, lifecycle, status line, /infinity command
  lib/
    config.ts         config files and defaults
    events.ts         InfinityEvent, formatting, dedup, spill
    jobs.ts           JobManager (process, ring buffer, watch batching)
    timers.ts         TimerStore, timezone math, restore from entries
    blocking.ts       bash command classifier
    overflow.ts       oversized tool result guard
    threads.ts        ids, stack check, task framing, thread files, report inbox
    sandbox.ts        SandboxBackend interface and git backend
    log.ts            error log (no silent catch)
  tools/
    jobs.ts           pi tool definitions for bg_*
    sleep.ts          pi tool definitions for sleep*
    threads.ts        pi tool definitions for threads and sandbox tools
agents/
  thread-fresh.md     subagent definition, session-mode standalone
  thread-fork.md      subagent definition, session-mode fork
scripts/install.sh    links agents and registers the package
check.bash            single quality gate
```

Design rules, taken from Infinity:

* Pure cores, thin adapters. Everything in `lib/` takes its clock, spawner, filesystem root
  and emitter as parameters and never imports pi at runtime. The adapters in `tools/` and
  `index.ts` are the only place that touches the pi API.
* One message type. Every asynchronous outcome is emitted through one `Emitter` that
  builds an `infinity-event` message (section 4).
* No silent failure. Every `catch` must rethrow, return an error value, or call
  `logError`. A test scans the source for empty catch blocks.

### 3.1 State and files

| Path | Content | Lifetime |
|------|---------|----------|
| `<artifacts>/infinity/jobs/<id>.log` | full job output | session |
| `<artifacts>/infinity/spill/<hash>.txt` | spilled event bodies and tool results | session |
| `<artifacts>/infinity/infinity.log` | error and debug log | session |
| session entries, type `infinity-timer` | timer set, fired, cancelled records | session file |
| `<agent-dir>/infinity/threads/<id>.json` | thread record read by the child process | until closed |
| `<child-session-file>.reports.jsonl` | child to parent report inbox | child session |
| `<repo>/.pi/sandboxes/<id>/` | git worktree | until squashed or pruned |

`<artifacts>` is `<session-dir>/artifacts/<session-id>` (same place pi-interactive-subagents
uses). Without a session file it falls back to `os.tmpdir()/pi-infinity/<pid>`.

### 3.2 Configuration

Read in order, later wins: defaults, `~/.pi/agent/infinity.json`, `<cwd>/.pi/infinity.json`.
Unknown keys are reported once through `ctx.ui.notify` and ignored.

```json
{
  "bash": { "guard": "block", "defaultTimeoutSec": 180, "sleepLimitSec": 20 },
  "jobs": { "max": 8, "tailLines": 40, "watchDebounceMs": 1000, "watchBatchLines": 20, "watchEventsPerMin": 6 },
  "events": { "maxChars": 4000, "seenCap": 2000 },
  "overflow": { "maxChars": 40000, "headChars": 6000, "tailChars": 2000 },
  "timers": { "max": 32 },
  "threads": { "enabled": true },
  "sandbox": { "root": ".pi/sandboxes", "autoCommit": true, "backend": "auto" }
}
```

`bash.guard` is `block`, `warn` or `off`.

## 4. The event model (P2, P3)

Every asynchronous outcome is delivered with `pi.sendMessage`:

```
customType: "infinity-event"
display: true
content: <text the model reads, see below>
details: { eventId, kind, seq, synthetic: true, source: { tool, callId, args } }
options: { triggerTurn: true, deliverAs: "steer" }
```

Kinds: `job_exit`, `job_match`, `timer`, `child_report`, `child_closed`, `notice`.

Content format (stable, tested):

```
[infinity event] <kind> from <tool> (<callId>)
original_args: <one line JSON, max 300 chars>
---
<body>
```

R-E1. `eventId` is `<source id>:<kind>:<seq>`. The emitter keeps a bounded seen-set
      (`events.seenCap`) and drops a second emit with the same id. This makes delivery
      idempotent like Infinity's processed-id set.
R-E2. Bodies longer than `events.maxChars` are written to `spill/<hash>.txt` and
      replaced by head, tail and the file path, even if they contain the spill marker.
R-E3. Delivery is always `steer` with `triggerTurn: true`, which is the same path
      pi-interactive-subagents uses for results. If a user message is pending the event
      queues behind it (interruptible by construction).
R-E4. A renderer is registered for `infinity-event`. Collapsed view is one line, expanded
      view shows the body.
R-E5. The emitter never throws. Failures go to `logError` and a `ui.notify` warning.
      If the warning itself fails, log that failure without propagating it.
R-E6. Before sending, persist the event input as an `infinity-event-pending` entry on
      the active session branch. A persisted `infinity-event` custom message acknowledges
      delivery. On startup, replay pending entries without an acknowledgement on that branch;
      restore the bounded seen-set from acknowledged messages. Send failures remain retryable.
      This is at-least-once delivery: a crash between message processing and persistence can
      redeliver. This acknowledges transcript persistence, not model processing. It cannot
      recover outcomes lost before their pending entry is persisted, except fired timers:
      startup reconstructs a missing timer event from its set and fired records, unless an
      valid outbox entry or delivered message already exists on the branch. Malformed
      outbox entries do not suppress reconstruction of fired timer events.
R-E7. Job event source ids include a fresh runtime nonce so a restarted session can reuse
      a tool-facing job id without colliding with earlier durable event ids.

## 5. Modules

### 5.1 Background jobs (P1, P5, P7)

Tools:

| Tool | Parameters | Returns |
|------|-----------|---------|
| `bg_run` | `command` (string), `name?`, `cwd?`, `watch?` (string[] of JS regex sources), `associative?` (boolean, default false), `timeout_seconds?`, `isolate?` (boolean, default false) | immediately, job id, pid, log path |
| `bg_output` | `id`, `tail?` (lines, default 40), `since?` (byte offset) | bounded text plus next offset |
| `bg_cancel` | `id` or `all: true` | state after the call, idempotent |
| `bg_list` | none | table of jobs |

R-J1. `bg_run` returns before the process produces output. It never waits.
R-J2. The process starts in its own process group (`detached: true`, shell `-c`) so a cancel
      reaches grandchildren.
R-J3. All output (stdout and stderr merged in arrival order) goes to the job log file. An
      in-memory ring buffer holds the last 64 KiB for fast tails. Job log paths are unique
      within the artifact directory, including across runtime restarts; existing logs are never reused.
      `bg_output` requires a non-negative safe integer `since` and a positive safe integer `tail`.
      Byte-range reads never split UTF-8 characters: a `since` inside a character skips its
      remaining bytes, and an incomplete character at the end is deferred to the next read.
      Once the job is finalized, later output from inherited pipes is discarded.
R-J4. Exit always emits one `job_exit` event with status (`exited`, `signaled`, `cancelled`,
      `timeout`, `error`), exit code, duration, the last `jobs.tailLines` lines, line count,
      and the log path. Tail is subject to R-E2. The job timeout stops when the shell exits,
      even if inherited output pipes remain open while the manager waits to finalize.
R-J5. `watch` patterns are compiled at start. An invalid pattern or one longer than 200
      characters fails the call with a clear error and starts nothing. To bound memory,
      watch patterns inspect at most the first 65536 UTF-16 code units of each line;
      longer lines are still counted once and retained in the log subject to its cap.
R-J6. Matching lines are batched. A batch is flushed after `watchDebounceMs` of quiet or at
      `watchBatchLines` lines. At most `watchEventsPerMin` match events are emitted per job
      per minute. Further matches are counted, not delivered, and reported in the exit
      event as "N matches suppressed".
R-J7. Delivery mode. By default (threaded in Infinity terms) matches are rate limited, so a
      noisy stream costs a bounded amount of context. With `associative: true` the rate limit
      is off and every batch is delivered, for streams where each line belongs in the
      conversation. Batching and the body size cap apply in both modes.
R-J8. `bg_cancel` sends SIGTERM to the group, waits 3 s, then sends SIGKILL to the group,
      even if its shell has already exited, to stop descendants that ignored SIGTERM. It
      returns without waiting for the exit. A second cancel on the same job is a no-op that
      reports the current state. Cancelling an unknown id is an error result, not a throw.
R-J9. On `session_shutdown` every running job is cancelled with the same procedure, without
      waiting. Disposing the runtime must not cancel the pending SIGKILL escalation for a
      process that ignored SIGTERM. Jobs do not survive a restart. This is stated in the tool description.
R-J10. At most `jobs.max` jobs run at once. Further `bg_run` calls fail with a message that
       lists running jobs.
R-J11. A user interrupt (escape) does not cancel jobs. Background work is the point.
R-J12. The `bg_run` description tells the model not to poll, not to sleep, and to end its turn
       or do independent work after dispatch.
R-J13. Opt-in `isolate: true` runs the job under macOS `/usr/bin/sandbox-exec`, denying
       filesystem writes outside the canonical working directory, which must be explicitly supplied.
       The default remains unrestricted. Symlinks do not grant writes outside that directory.
       Unsupported platforms, unavailable sandbox-exec, invalid working directories and profile
       setup failures must not run the command unrestricted. Network and reads remain allowed.
       This is accidental-write reduction, not a security guarantee: the working directory may
       contain sensitive files, other processes can still be contacted, and sandbox-exec is deprecated.

### 5.2 Bash guard (P1)

R-B1. `tool_call` handler for `bash`. If `bash.guard` is `block` and the command matches the
      classifier (below), the call is blocked with a reason that names `bg_run` or `sleep`.
      With `warn` the call runs and the user sees a UI notice (no model turn). With `off` nothing happens.
R-B2. Classifier flags: `sleep N` with N at or above `sleepLimitSec` (also `sleep Nm`, `Nh`),
      `tail -f`, `tail -F`, `tail --follow`, `watch <cmd>`, `while true`, `while :`, known
      dev servers (`npm|pnpm|yarn|bun run dev|start|serve`, `vite`, `next dev`,
      `python -m http.server`, `php -S`, `rails s`), `docker compose up` without `-d`.
R-B3. A command that ends with a lone `&`, or starts with `nohup`, `setsid` or `timeout`, is
      not flagged. Quoted text is not scanned (the classifier tokenizes first).
R-B4. If the call has no `timeout` argument, set it to `bash.defaultTimeoutSec`.
R-B5. False positives must be cheap to escape: the block reason says how to set
      `bash.guard` to `warn`.

### 5.3 Sleep and timers (P4)

| Tool | Parameters |
|------|-----------|
| `sleep` | `seconds` (1 to 604800), `note?` |
| `sleep_until` | `date` (YYYY-MM-DD), `time` (HH:MM or HH:MM:SS), `timezone` (IANA) , `note?` |
| `sleep_until_event` | `note?` |
| `timer_cancel` | `id` or `all: true` |

R-T1. `sleep` and `sleep_until` register a timer and return at once with `terminate: true`.
      The agent loop ends without another model call. The wake up arrives as a `timer`
      event. A past target fires immediately.
R-T2. `sleep_until_event` registers nothing, returns `terminate: true`. It exists so the model
      has an explicit way to wait for jobs, children and the user.
R-T3. Timers are passive: they never block other work, and a user message sent while a timer
      is pending is handled normally. The timer still fires later.
R-T4. Timers are durable. Each set, fire and cancel is appended with
      `pi.appendEntry("infinity-timer", record)`. On `session_start` the store replays the
      branch, re-arms pending timers, and fires overdue ones at once with the body
      "(late by N s)".
R-T5. Delays above 2^31-1 ms are chained.
R-T6. `sleep_until` resolves the wall clock time in the given IANA zone with `Intl`. It must
      handle DST gaps (nonexistent local time moves forward) and overlaps (earlier instant).
      Four-digit dates use astronomical year numbering, including year 0000. An invalid
      zone or date is an error result.
R-T7. At most `timers.max` pending timers.

### 5.4 Oversized result guard (P8)

R-O1. `tool_result` handler for every tool except `read`. If the summed text length exceeds
      `overflow.maxChars`, write the full text to `spill/` and return replaced content: first
      `headChars`, a marker line with total size and the path, last `tailChars`, plus the
      sentence telling the model to use `read` with offset and limit on that path.
R-O2. Error results are processed the same way. Non-text content passes through unchanged.
R-O3. A spill marker in tool output does not exempt oversized content from the guard.

### 5.5 Threads (P6, P7, P14)

Transport is pi-interactive-subagents. Thread tools call `subagent` and `subagent_message`
through `ctx.executeTool`. If those tools are missing, the thread module reports that once
and does not register its tools.

| Tool | Where | Parameters |
|------|-------|-----------|
| `spawn_thread` | root and thread agents | `instructions`, `child_of` (string[]), `fresh_context?`, `model?`, `sandbox?` |
| `report_to_parent` | thread agents | `report?`, `structured?` |
| `close_thread` | thread agents | `report?`, `structured?` |
| `send_message_to_child` | root and thread agents | `thread_id`, `message` |
| `squash_sandbox` | root and thread agents | `thread_id`, `commit?` |

New thread ids are `t-` followed by 32 lowercase hexadecimal digits; legacy six-digit ids
remain valid. The root thread id is `root`. A thread's stack is the list of ids from root to itself.

R-H0. New thread ids contain 128 random bits, making collisions across sessions and processes
      negligibly likely without persistent allocation state.

R-H1. `spawn_thread` checks `child_of` against the caller's real stack. The real stack is
      `["root"]` in the main session and is read from the thread file in a thread session.
      On mismatch the call fails with: "You are thread <id> with stack [..]. The spawn plan
      you inherited belongs to [..]. Focus on your own task and do not spawn the parent's
      threads." (This is the Infinity guard.)
R-H2. `fresh_context: true` launches agent `thread-fresh` (session-mode standalone). Absent
      or false launches `thread-fork` (session-mode fork). Both agents are in `agents/`.
R-H3. The task text starts with a header that tells the child its id, its stack, its parent,
      whether its context is fresh, and the exact closing procedure. Fresh threads get a
      sentence that the instructions are self-contained.
R-H4. Before launch the parent writes the thread file. After launch it records the session
      file returned by `subagent` and starts watching `<session>.reports.jsonl`.
R-H5. `report_to_parent` appends one JSON line `{type:"report", seq, text, at}`. The parent
      watcher (fs.watch with a 1 s poll fallback) turns each line into a `child_report`
      event once (dedup by `<thread>:report:<seq>`), preserving UTF-8 characters split
      across reads. A disappeared inbox is ignored; other read errors are logged.
R-H6. `close_thread` appends `{type:"closed", report?}` and returns `terminate: true`. The
      parent emits `child_closed` with the report. The thread session then exits through
      the subagent auto-exit path.
R-H6a. Reports may instead use `structured: {summary, files?, tests?, blockers?}`, where
       `summary` is a nonempty string and each optional field is an array of strings. A report
       cannot contain both `report` and `structured`; `report_to_parent` requires one. Structured
       reports are serialized in the existing text field and rendered concisely for the parent.
       Children using the blocking transport may return the same JSON object as their final
       message. Unrecognized or invalid JSON remains ordinary text, preserving legacy reports.
R-H6b. `spawn_thread` accepts optional `depends_on`, an array of distinct direct child IDs.
       Before creating a sandbox or launching, it rejects unknown, unfinished, or known failed
       prerequisites. Detached transport errors and sandbox finalization failures are failures.
       Interactive completion, including an implicit process exit, has an unknown outcome and
       counts as completion only, not verified success; callers must inspect its report. This is a
       guard, not a queue: the caller waits for completion events and retries. Results remain
       session-local and are not restored after restart.
R-H7. `send_message_to_child` accepts only running direct children recorded in the parent's own
      thread registry. It calls `subagent_message` with the thread's name. Threads that have begun
      closing or are closed cannot receive messages; tell the caller to spawn a new thread.
R-H7a. Interactive transport failures returned in the nested tool's `details.error` are failures
       even when `executeTool` reports `isError: false`; propagate them to the caller. A failed
       launch must not leave a running thread record or sandbox.
R-H8. Thread files and watchers are removed when the child closes or the parent session shuts
      down (best effort, logged). A launch that resolves after shutdown is not registered and must
      not recreate its thread file or watcher; its spawn call fails. A detached launch that starts
      during shutdown is aborted. Any sandbox created before shutdown is left intact.
R-H9. Thread agents may spawn further threads (`subagent_agents` lists all thread agents and
      aliases). When the requested mode would use the caller's own agent name, launch the
      equivalent alias to satisfy the interactive transport's self-spawn restriction. Both
      fresh and fork modes remain available at every permitted depth. Depth is capped at 4.
R-H10. Prompt guidance (R-G1) tells the model when to choose fresh context: independent task,
       long parent conversation, instructions can be made self-contained.

R-H11. Optional `threads.adaptiveConcurrency` limits concurrent direct children per parent session,
       including launches in progress and children finalizing. It is disabled by default. When enabled,
       `min`, `initial`, and `max` are positive integer limits with min <= initial <= max;
       `successesToIncrease` is a positive integer, and `decreaseFactor` is strictly between 0 and 1.
       The initial limit increases by one after that many consecutive successful child completions,
       up to max. A failed launch or unsuccessful child completion resets the success streak and
       multiplies the limit by decreaseFactor, rounded down and bounded by min. A rejected admission
       does not count as a failure. Calls over the current limit fail immediately with guidance to
       wait and retry; no queue or cancellation is implied. A reduction never stops running children.
       State is in memory, scoped to one parent session, and reset on restart. Invalid settings are
       reported and replaced with defaults.

### 5.6 Sandboxes (P10)

`SandboxBackend` interface: `detect(cwd)`, `create({id, base, root})`, `commitAll(sb,
message)`, `diffStat(sb)`, `squashInto(target, sb, {commit})`, `remove(sb, {keepBranch})`,
`list()`, `pruneMerged()`, optional `hasPendingWork(path)`. Two implementations ship:
`GitSandbox` (worktrees) and `JjSandbox` (workspaces and bookmarks). `sandbox.backend` is
`auto` (default, jj wins when the directory is a jj repository, otherwise git), `git` or `jj`.
The rules below are written for git. The jj backend maps each one to the closest jj
operation, and the mapping is documented in `extensions/lib/sandbox-jj.ts`.

R-S1. `spawn_thread({sandbox:true})` in a git repo runs `git worktree add -b sandbox-<id>
      <root>/<id> <base>`. Base is the parent's sandbox branch if the parent has one, else
      `HEAD`. The child's `cwd` is the worktree. Outside a git or jj repo the call fails
      before anything is spawned.
R-S2. `<root>` is added to `.git/info/exclude` so worktrees never show up as untracked.
R-S3. On `child_closed`, if `sandbox.autoCommit`, commit all changes in the worktree with
      hooks disabled (`-c core.hooksPath=/dev/null`) and the message `thread <id>`.
R-S4. The `child_closed` event lists `git diff --stat` against the base and the branch name.
R-S5. `squash_sandbox` rejects running children and children still finalizing their sandbox;
      only after finalization completes may it merge the child branch into the caller's worktree with
      `git merge --squash`. If the caller is a sandboxed thread, the result is committed
      (same rules as R-S3). If the caller is the root session, the changes stay staged and
      uncommitted, and the user must confirm first (`ctx.ui.confirm`). Without UI the call
      refuses. Both backends refuse a target with uncommitted file changes, rather than
      mixing unrelated work into the squash or its commit. Git squash refuses to overwrite
      ignored files in the target.
R-S6. Conflicts abort the squash (`git merge --abort` or reset), leave the child branch
      intact, and return the conflicting paths as an error result.
R-S7. After a successful squash the worktree is removed and the branch is kept. `/infinity
      sandboxes` lists branches, `/infinity prune` deletes merged ones after confirmation and
      refuses while the working tree holds applied sandbox work that is not committed. A
      git branch counts as merged when its current tip was squashed, or when it moved past
      its recorded base and is an ancestor of HEAD. Moving a branch after a squash invalidates
      its squash marker; legacy markers without a recorded tip do not prove it merged. A fresh
      branch is never merged. A jj bookmark counts as merged only when its current commit
      matches the recorded post-squash commit; old path-only markers are not proof of a merge.
      Before recursively deleting a jj workspace directory, including one under an absolute
      sandbox root outside the repository, removal verifies its registered name and path and
      its repository pointer; if verification fails, it leaves both the directory and the
      registered workspace intact. Failed creation cleanup applies the same checks and never
      deletes an unverified directory, including one created concurrently by another process.
      A failed git worktree add does not establish ownership of its destination or branch;
      failed creation therefore leaves both untouched rather than deleting a concurrent worktree.
R-S9. When the subagent process of a thread ends without `close_thread`, the parent closes the
      thread itself (commit, diff stat, `child_closed` event). When `close_thread` already
      ran, the generic subagent exit message is shortened to one line.
R-S8. The root session is never moved into a sandbox. It is the user's own session.

### 5.7 Prompt guidance (P1, P14)

R-G1. A single system prompt section, added through tool `promptGuidelines` on `bg_run`,
      `sleep` and `spawn_thread`, says: never wait on slow work, dispatch and yield, never
      poll, results arrive as `[infinity event]` messages, prefer fresh-context threads for
      independent work, do not fabricate results of work you started and have not seen.
R-G2. Each tool description is under 900 characters. A test checks length and key phrases.

### 5.8 UI and commands

R-U1. Status line `infinity` shows `jobs N, timers N, threads N` when any is non zero.
R-U2. `/infinity` shows the table. Subcommands: `jobs`, `timers`, `threads`, `sandboxes`,
      `cancel <id|all>`, `prune`, `config`.
R-U3. No terminal-only UI in non-tui modes. Everything must work in print and rpc mode.

## 6. Error handling (P12)

* `lib/log.ts` exports a logger with `error(scope, err)`. It appends to `infinity.log` and
  never throws.
* Best-effort operations (cancel notifications, directory cleanup) catch, call `logError`,
  and continue. They never return silently.
* Assertion messages that signal a logic bug start with `bug:`.
* Test `no-silent-catch` fails the build if a catch block has an empty body.

## 7. Quality gate

`check.bash` runs, in order: prettier check, `tsc --noEmit`, and all tests. The tests include
an empty-catch scan and a docs consistency test (every tool in the README table is
registered and every registered tool is documented). A formatting failure prints one hint
(`npm run fmt`) instead of a diff, so agents rerun the formatter instead of editing by hand
(P12). CI runs the same script.

## 8. Test strategy

* Unit tests for every `lib/` module with fake clock, fake spawner, temp dirs.
* Git and jj sandbox tests against real temporary repositories.
* Job tests with real `sh -c` processes for the exit and cancel paths.
* Adapter tests with a fake pi object that records `registerTool`, `on`, `sendMessage`.
* Docs test described in section 7.
* One manual smoke test in a tmux session with the real pi binary (Sprint 6), recorded in
  the retrospective.

Definition of done for a story: acceptance criteria covered by tests, `check.bash` green,
SPEC updated if behavior changed, Conventional Commit created.

## 9. Agile plan

Product backlog, in priority order. Points are relative (1 small, 3 large).

| ID | Story | Pts | Sprint |
|----|-------|-----|--------|
| S0 | Research, spec, repo, gate script | 3 | 0 |
| E1 | Event model, emitter, renderer, dedup, spill | 3 | 1 |
| J1 | Background jobs and watch batching | 3 | 1 |
| B1 | Bash guard and default timeout | 2 | 2 |
| O1 | Oversized result guard | 1 | 2 |
| T1 | Sleep tools and durable timers | 3 | 2 |
| X1 | Sandbox backend (git) | 3 | 3 |
| H1 | Threads on top of subagents | 3 | 4 |
| H2 | Sandbox integration into threads, squash | 2 | 5 |
| U1 | Status line, /infinity command, config | 2 | 5 |
| D1 | README, install script, docs test, smoke test | 2 | 6 |
| B-1 | jj sandbox backend | 3 | 7 |
| B-2 | Triage child per noisy event stream (true threaded subscriptions) | 3 | backlog |
| B-3 | Tool-result dedup against history tail | 2 | backlog |
| B-4 | Shorten the generic subagent exit message for closed threads | 2 | 7 (the parent still wakes once more) |
| B-5 | Close and commit a thread that ends without close_thread | 1 | 7 |
| B-6 | Refuse prune while applied sandbox work is uncommitted | 1 | 7 |
| P-1 | Polish: prettier, CI, AGENTS.md, real pi dependencies, README | 2 | 7 |
| X-1 | Second thread transport on pi-subagents (section 11) | 5 | 8 to 10 |
| B-7 | Fork emulation on pi-subagents (bounded conversation excerpt) | 2 | backlog |
| B-8 | Live progress of the nested call in the status line | 1 | backlog |

Sprints:

* Sprint 0, foundation. Output: this spec, repo, `check.bash`, package skeleton.
* Sprint 1, messages and jobs. Exit criterion: `bg_run` of a failing and a passing command
  each produce exactly one `job_exit` event in tests, cancel kills a process tree.
* Sprint 2, yielding. Exit criterion: guard blocks `sleep 60` and allows `sleep 2`; a timer set
  in one store instance fires after restore in a second instance.
* Sprint 3, sandboxes. Exit criterion: create two children from one base, squash both into a
  parent, conflict case returns paths and leaves state clean.
* Sprint 4, threads. Exit criterion: `child_of` mismatch rejected; report file line becomes
  one event; `fresh_context` selects the right agent. Real spawn proven in Sprint 6.
* Sprint 5, integration. Exit criterion: spawn with sandbox end to end in unit tests with a
  fake `executeTool`; `/infinity` renders.
* Sprint 6, hardening. Exit criterion: smoke test in tmux with real pi, README and install
  script verified, retrospective written.

* Sprint 7, jj and polish. Exit criterion: the jj backend passes the same scenarios as git on
  real jj repositories, B-4 to B-6 covered by tests, the gate includes formatting, CI file in
  place.

Each sprint ends with a review against its exit criterion, a commit, and a short
retrospective entry appended to section 10.

Risks:

| Risk | Mitigation |
|------|-----------|
| `ctx.executeTool("subagent")` or `registerToolExtension` behave differently than read in source | Smoke test early in Sprint 4, keep the thread module optional |
| Guard false positives annoy the user | `warn` and `off` modes, narrow classifier, config in README |
| `terminate: true` skips a follow-up the model needed | Only sleep tools use it, and their text says the wake up message will arrive |
| fs.watch flakiness on macOS | Poll fallback every second |

## 10. Sprint log

Sprints 1 to 5 were compressed into one working session. Timers and the git sandbox were
built by two parallel sub-agents against the interfaces in this spec, the rest by the lead.
All exit criteria were met by tests (105 tests, about 4.5 s).

Sprint 6 smoke test (real pi 1.4.0 in tmux, model glm-5.3, temp git repo)

* `bg_run` started a 4 s job, the model yielded with `sleep_until_event`, the `job_exit`
  event woke it and it answered with the exit code. Render line showed correctly.
* `spawn_thread` with `fresh_context` and `sandbox` created the worktree, ran a child under
  agent `thread-fresh`, the child wrote a file and called `close_thread`. The parent got
  `child_closed`, the branch had the auto commit, `squash_sandbox` asked for confirmation
  and staged the file in the main tree without committing.

Retrospective

* Worked. Pure cores with injected deps made 105 tests fast. `terminate: true` gives a real
  yield. The `registerToolExtension` hook and `executeTool("subagent")` behaved as read in
  source, and the session file path in the `subagent` result is usable as the inbox base.
* Deviations from the first draft. Warn mode is a UI notice, not an event (an event would
  trigger a model turn). R-J7 was rewritten: the difference between default and associative
  is the rate limit.
* Known gap, backlog B-4. pi-interactive-subagents always sends its own `subagent_result`
  when a child exits, so the parent wakes twice per child (our `child_closed` and the
  generic exit message, which is empty for children that end with `close_thread`). Fixing
  it needs a hook in the subagents extension to mute results for threads.
* Known gap, backlog B-5. A thread that ends without `close_thread` is not auto
  committed until `squash_sandbox` runs (it commits first, so no work is lost).
* The sandbox worker flagged that `pruneMerged` treats a branch as merged after a root
  squash that is still only staged. Prune asks for confirmation, so the risk is small, but
  the tool layer should refuse when `git diff --cached` is non-empty (backlog B-6).
* Tests were slow at first because fs watchers kept the process alive. Watchers and poll
  timers are now unref'd, the full suite runs in about 4.5 s.

Sprint 7, jj and polish

* `JjSandbox` implements the backend interface with jj workspaces and bookmarks, tested
  against real jj 0.46 repositories (colocated and not). jj facts that shaped it: a squash
  makes the source workspace stale (the backend runs `jj workspace update-stale` once and
  retries), `--keep-emptied` is needed so the bookmark survives, jj commits conflicts so the
  backend detects them with `jj resolve --list` and restores the previous operation, and the
  squashed marker lives in `.jj/pi-infinity-squashed.json` because jj has no per-repo config.
* `merged` is now explicit: squashed marker, or moved past the recorded base and an ancestor
  of HEAD. This fixed fresh branches showing up as merged.
* B-4 to B-6 done as described in the backlog table. The parent still wakes once for the
  generic exit message, now with a one line body.
* The tool list lost the unused `name` parameter of `spawn_thread`.
* The gate gained formatting, pi packages became real dev dependencies, CI and `AGENTS.md`
  were added, the README was rewritten.

## 11. Second thread transport: pi-subagents

Added after v1. Goal: `spawn_thread` also works on top of
[amosblomqvist/pi-subagents](https://github.com/amosblomqvist/pi-subagents), without changing
anything for users of pi-interactive-subagents.

### 11.1 Research

Read from the source of pi-subagents (index.ts, 932 lines):

| Aspect | pi-interactive-subagents | pi-subagents |
|--------|--------------------------|--------------|
| Tool surface | `subagent`, `subagent_message`, `subagents_list` | `subagent` only |
| `subagent` params | agent, task, name, model, cwd | agent, task, cwd |
| Call semantics | returns at once, result steered later | blocks until the child ends, returns its last assistant text |
| Child process | tmux pane, session file, resumable | headless `pi --mode json -p --no-session --no-extensions` |
| Context | per agent definition (fork or fresh) | always fresh, task text only |
| Agent registry | markdown files, discovery | `globalThis.__pi_subagents.registerAgent(config)` at runtime |
| Tools in child | whitelist plus `registerToolExtension(name, path)` | whitelist, but only tools in a hard-coded map are kept, others are silently dropped |
| Concurrency | none | semaphore, default 4, extra calls wait |
| Cancel | pane close | the tool signal sends SIGTERM then SIGKILL to the child process |

Consequences:

* Our child-side tools (`report_to_parent`, `close_thread`, `bg_*`) cannot reach a
  pi-subagents child, there is no hook to map them. The child gets built-in tools only.
* There is no live channel from child to parent. The only message is the final output.
* Forking the parent conversation is impossible. Children are always fresh.
* The call blocks, so `spawn_thread` must run it detached to keep returning at once. The
  nested call has to use its own `AbortController`, because the signal of the spawning tool
  call ends with that call.
* Registering an agent per thread (`thread-<id>`) avoids races between parallel spawns with
  different models, and lets us pass the model, which the tool schema does not accept.

### 11.2 Requirements

R-X1. `threads.transport` is `auto` (default), `interactive` or `subagents`. Auto picks
      interactive when a `subagent_message` tool exists, otherwise subagents when a
      `subagent` tool and `globalThis.__pi_subagents.registerAgent` exist, otherwise no
      transport (one warning, `spawn_thread` explains itself when called).
R-X2. Nothing changes on the interactive path. All tests that existed before this section
      pass unmodified.
R-X3. On the subagents transport `spawn_thread` returns at once. The nested `subagent` call is
      started without awaiting it and carries its own `AbortController`.
R-X4. Per thread, an agent named `thread-<id>` is registered just before the call and
      unregistered when the call settles. Its model is the `model` parameter, else the current
      session model. Its tools are the built-ins. Its system prompt is
      `agents/blocking/thread-blocking.md`. If the nested tool throws synchronously while
      starting, unregister the agent before propagating the failure.
R-X5. `fresh_context` other than `true` is rejected before any side effect, with a message
      that names the reason and says to pass `fresh_context: true` with self-contained
      instructions.
R-X6. When the nested call settles, the thread closes: `child_closed` carries the final output
      (an error output is labeled as an error). A sandbox is committed and its diff stat is
      listed, exactly as on the interactive path.
R-X7. `send_message_to_child` fails with a clear message on this transport. Child tools are
      not offered, so `report_to_parent` and `close_thread` do not exist for these children.
      Thread depth is 1.
R-X8. Session end aborts running subagents-transport threads. Their sandboxes stay intact.
      A spawn still preparing a sandbox at session end must not launch a child afterward;
      any sandbox already created stays intact.
R-X9. The task frame for this transport says: you have built-in tools only, your last message
      is the final report, there is no `close_thread`.
R-X10. If the nested call is queued by the pi-subagents semaphore, the thread simply stays
       running. No extra handling.
R-X11. `/infinity threads` shows the transport of each thread.
R-X12. README documents what each transport supports.

### 11.3 Plan

* Sprint 8, abstraction. Move launch details behind a transport field of `ThreadIO`, keep
  behavior identical. Exit: the full pre-existing suite passes unmodified.
* Sprint 9, subagents transport. Spawn, detach, close, abort, rejection rules. Exit: contract
  tests against a fake that implements the documented pi-subagents surface (blocking
  `subagent`, `registerAgent`, schema with only agent, task, cwd).
* Sprint 10, direct testing. Real pi 1.4 in tmux with pi-subagents installed and
  pi-interactive-subagents absent (isolated agent directory), a real model, a sandboxed
  thread. Exit: thread spawns, the parent keeps working, the close event arrives, a squash
  works. Then docs and retrospective.

Risks: `ctx.executeTool` may not work after the spawning call returned (mitigation: smoke
test first, fall back to running the child process ourselves if it fails); the
`__pi_subagents` registry could change upstream (mitigation: feature-detect, one warning).

Sprints 8 to 10, second transport

* The launch moved behind `ThreadIO.transport`, absent meaning interactive. The 123 tests
  that existed before this work pass unmodified (R-X2). 22 tests were added: transport choice,
  launcher, service behavior on the subagents transport, adapter level.
* Direct testing with real pi 1.4.0 and the real pi-subagents source in an isolated agent
  directory (no other subagent extension, a real model):
  * a sandboxed fresh thread ran detached, the parent kept working, `child_closed` carried the
    final report, `squash_sandbox` staged the file after confirmation (R-X3, R-X6)
  * two parallel threads, one slow, closed independently and in finish order (R-X10)
  * a fork request was rejected with the guidance text (R-X5)
  * quitting pi killed a running child and its `sleep`, left the sandbox branch and the
    partial file in place (R-X8)
  * the same scenario on pi-interactive-subagents with the new code still passes
* `scripts/smoke.sh subagents|interactive` automates the sandbox scenario for both transports
  and is exposed as `npm run smoke:*`. It is opt in because it needs a model.
* R-D2. Smoke cleanup retries temporary directory removal after stopping its own tmux session,
  to tolerate late child writes. Persistent removal failures are reported and fail the run.
* Finding: `ctx.executeTool` keeps working after the spawning tool call returned, as long as
  the nested call carries its own `AbortController`. No fallback runner was needed.
* Finding: pi-subagents drops tools it does not know, so children there cannot get
  pi-infinity tools. Reports and nesting are therefore not available on that transport. This is
  documented in the README matrix instead of worked around.
* Backlog: B-7 fork emulation on pi-subagents by passing a bounded excerpt of the parent
  conversation, B-8 surface the live progress of the nested call in the status line.
