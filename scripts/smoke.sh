#!/usr/bin/env bash
# End to end check with the real pi binary and a real model. Opt in, it costs a few cents.
#
#   scripts/smoke.sh subagents      thread on pi-subagents (headless, final report)
#   scripts/smoke.sh interactive    thread on pi-interactive-subagents (tmux pane)
#
# Each run uses a throwaway agent directory, so only the chosen subagent extension is loaded
# next to pi-infinity, and your own settings stay untouched. Needs tmux, git, node and a
# configured provider in ~/.pi/agent (auth.json).
#
# Environment:
#   SMOKE_MODEL                      default openrouter/z-ai/glm-5.3
#   PI_SUBAGENTS_DIR                 checkout of pi-subagents, cloned to a temp dir when unset
#   PI_INTERACTIVE_SUBAGENTS_DIR     default ~/.pi/agent/extensions/pi-interactive-subagents
#   SMOKE_TIMEOUT                    seconds to wait for the thread, default 150
set -euo pipefail

mode="${1:-}"
case "$mode" in subagents | interactive) ;; *)
  echo "usage: $0 subagents|interactive" >&2
  exit 2
  ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/scripts/smoke-cleanup.sh"
user_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
model="${SMOKE_MODEL:-openrouter/z-ai/glm-5.3}"
limit="${SMOKE_TIMEOUT:-150}"
work="$(mktemp -d)"
agent_dir="$work/agent"
project="$work/project"
session="pi-smoke-$$"
mkdir -p "$agent_dir/extensions" "$agent_dir/agents" "$project"

cleanup() {
  tmux kill-session -t "$session" 2>/dev/null || true
  smoke_remove_work "$work"
}
trap cleanup EXIT

# Credentials and settings, with every package replaced by pi-infinity from this checkout.
for f in auth.json models-store.json; do
  if [ -f "$user_dir/$f" ]; then cp "$user_dir/$f" "$agent_dir/$f"; fi
done
USER_SETTINGS="$user_dir/settings.json" OUT="$agent_dir/settings.json" REPO="$repo_root" node -e '
  const fs = require("fs");
  let s = {};
  try { s = JSON.parse(fs.readFileSync(process.env.USER_SETTINGS, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
  s.packages = [process.env.REPO];
  delete s.extensions;
  fs.writeFileSync(process.env.OUT, JSON.stringify(s, null, 2));
'

if [ "$mode" = subagents ]; then
  src="${PI_SUBAGENTS_DIR:-}"
  if [ -z "$src" ]; then
    src="$work/pi-subagents"
    git clone -q --depth 1 https://github.com/amosblomqvist/pi-subagents "$src"
  fi
  cp -R "$src" "$agent_dir/extensions/pi-subagents"
else
  src="${PI_INTERACTIVE_SUBAGENTS_DIR:-$HOME/.pi/agent/extensions/pi-interactive-subagents}"
  [ -d "$src" ] || { echo "pi-interactive-subagents not found at $src" >&2; exit 2; }
  ln -s "$src" "$agent_dir/extensions/pi-interactive-subagents"
  for a in thread-fresh thread-fork thread-fresh-nested thread-fork-nested; do ln -s "$repo_root/agents/$a.md" "$agent_dir/agents/$a.md"; done
fi

git -C "$project" init -q -b main
git -C "$project" config user.email smoke@example.org
git -C "$project" config user.name smoke
echo one >"$project/a.txt"
git -C "$project" add -A
git -C "$project" -c core.hooksPath=/dev/null commit -q -m init

tmux new-session -d -s "$session" -x 200 -y 50 -c "$project" "PI_CODING_AGENT_DIR=$agent_dir pi --model $model"
sleep 10

if [ "$mode" = subagents ]; then
  finish="reply with a one line final report"
else
  finish="call close_thread with the report done"
fi
tmux send-keys -t "$session" "Call spawn_thread with child_of [\"root\"], fresh_context true, sandbox true and instructions: create a file child.txt containing hi in your working directory, then $finish. After that stop and wait." Enter

deadline=$((SECONDS + limit))
found=""
while [ $SECONDS -lt $deadline ]; do
  pane="$(tmux capture-pane -t "$session" -p -S -200)"
  if grep -q "child_closed from spawn_thread" <<<"$pane"; then
    found=yes
    break
  fi
  sleep 3
done

# Capture first: grep -q closes the pipe early, which pipefail would report as a failure.
branches="$(git -C "$project" branch --list 'sandbox-*')"
commits="$(git -C "$project" log --all --oneline)"
status=0
if [ -z "$found" ]; then
  echo "FAIL ($mode): no child_closed event within ${limit}s"
  tmux capture-pane -t "$session" -p | tail -25
  status=1
elif ! grep -q sandbox- <<<"$branches"; then
  echo "FAIL ($mode): event arrived but no sandbox branch exists"
  status=1
elif ! grep -q "thread t-" <<<"$commits"; then
  echo "FAIL ($mode): sandbox branch has no auto commit"
  echo "$commits"
  tmux capture-pane -t "$session" -p | grep -v '^$' | tail -15
  status=1
else
  echo "PASS ($mode): thread ran in a sandbox and its close event arrived"
fi
exit $status
