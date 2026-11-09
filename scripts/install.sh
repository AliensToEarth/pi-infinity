#!/usr/bin/env bash
# Install pi-infinity and its interactive thread transport in one invocation.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

for command in pi node git tmux; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "pi-infinity: $command is required; install it before running this installer." >&2
    exit 1
  fi
done
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "pi-infinity: Node 24 or newer is required." >&2
  exit 1
fi

packages="$(pi list --no-approve)"
if [[ ! -f "$agent_dir/extensions/pi-interactive-subagents/pi-extension/subagents/index.ts" ]] &&
   ! grep -Fq 'pi-interactive-subagents' <<<"$packages"; then
  pi install git:github.com/amosblomqvist/pi-interactive-subagents
fi
if ! grep -Fq 'pi-infinity' <<<"$packages"; then
  pi install "$repo"
fi

mkdir -p "$agent_dir/agents"
for agent in thread-fresh thread-fork thread-fresh-nested thread-fork-nested; do
  target="$agent_dir/agents/$agent.md"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    ln -s "$repo/agents/$agent.md" "$target"
  elif [[ ! "$target" -ef "$repo/agents/$agent.md" ]]; then
    echo "pi-infinity: $target already exists and was not replaced." >&2
  fi
done
echo "pi-infinity is installed. Start or reload pi inside tmux to use threads."
