# pi-infinity

Design rules from the [Infinity](https://github.com/hydro-project/infinity) agent runtime, as a
pi package. Slow work never blocks the turn, every asynchronous outcome comes back as one
bounded message, timers survive restarts, and parallel code changes happen in isolated git
worktrees or jj workspaces.

Threads are built on [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).
The reasoning behind every feature is in [`SPEC.md`](SPEC.md).

## Requirements

* pi 1.4 or newer
* Node 24 or newer (the tests run TypeScript directly)
* For threads: pi-interactive-subagents and tmux. Jobs, timers and the guards work without them.
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
| `bg_run` | Start a shell command in the background and return at once. The exit arrives as an event. Optional `watch` regexes. |
| `bg_output` | Read a job's output without waiting, as a tail or a byte range. |
| `bg_cancel` | Cancel one job or all. SIGTERM, then SIGKILL after 3 s. Safe to repeat. |
| `bg_list` | List jobs. |
| `sleep` | Durable timer. Ends the turn, a timer event wakes the agent. |
| `sleep_until` | Same, for a wall clock time in an IANA zone. |
| `sleep_until_event` | Yield with nothing scheduled and wake on any event or user message. |
| `timer_cancel` | Cancel timers. |
| `spawn_thread` | Child thread in a tmux pane. `child_of` stack check, `fresh_context`, `sandbox`. |
| `send_message_to_child` | Message a direct child, or resume it. |
| `squash_sandbox` | Merge a child's sandbox into the caller's tree. |
| `report_to_parent` | Thread sessions only. Intermediate report. |
| `close_thread` | Thread sessions only. Final report, ends the session. |

## Events

Everything asynchronous comes back as a message of type `infinity-event`:

```
[infinity event] job_exit from bg_run (call_abc)
original_args: {"command":"npm test"}
---
job j1 "npm" finished: exited (exit code 1, 42s)
...
```

Events are deduplicated by id, delivered as steer messages (so they queue behind user input),
and capped at 4000 characters. A longer body is written to a file and replaced by its head,
tail and the path.

## Guards

* **Bash guard.** `sleep 60`, `tail -f`, `watch`, endless loops and foreground dev servers are
  refused with advice to use `bg_run` or `sleep`. Bash calls without a timeout get 180 s.
* **Result guard.** A tool result above 40000 characters is saved to a file and replaced by its
  head, tail and the path. `read` is exempt so the file can be paged through.

## Threads and sandboxes

```
spawn_thread({ instructions: "...", child_of: ["root"], fresh_context: true, sandbox: true })
```

* `fresh_context: true` starts the child with an empty history (agent `thread-fresh`).
  Without it the child forks your conversation (agent `thread-fork`).
* `child_of` must be your real stack. A forked child that tries to replay its parent's spawn
  plan is rejected.
* `sandbox: true` gives the child its own checkout under `.pi/sandboxes/<id>` on a
  `sandbox-<id>` branch (git worktree) or bookmark (jj workspace). The backend is chosen
  automatically, jj first. When the child closes, its work is committed there and the event
  shows the diff stat. A child that exits without closing is closed for it.
* `squash_sandbox` merges the branch into the caller's tree. In the main session the changes
  are only staged (git) or left in the working-copy change (jj), and the user confirms first.
  Inside a sandboxed thread the result is committed.

## Commands

| Command | Effect |
|---------|--------|
| `/infinity` | Jobs, timers and threads |
| `/infinity cancel <id\|all>` | Cancel a job or timer |
| `/infinity sandboxes` | List sandbox branches |
| `/infinity prune` | Delete merged sandbox branches after confirmation |
| `/infinity config` | Show the effective configuration |

## Configuration

`~/.pi/agent/infinity.json`, then `<project>/.pi/infinity.json`. Defaults live in
`extensions/lib/config.ts` and the shape is documented in section 3.2 of `SPEC.md`.

```json
{ "bash": { "guard": "warn" }, "sandbox": { "backend": "git" } }
```

`bash.guard` is `block`, `warn` or `off`. `sandbox.backend` is `auto`, `git` or `jj`.

## Troubleshooting

* `spawn_thread` says the subagent tools are missing: install pi-interactive-subagents and
  start pi inside tmux.
* A thread starts without pi-infinity tools: run `./scripts/install.sh` again, it relinks
  the two agent definitions.
* The guard blocks something harmless: set `bash.guard` to `warn`.
* Errors from background machinery go to `<session artifacts>/infinity/infinity.log`.

## Development

```
./check.bash       # format, typecheck, tests
npm run fmt        # fix formatting
```

Read [`AGENTS.md`](AGENTS.md) first.

## License

MIT
