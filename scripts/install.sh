#!/usr/bin/env bash
# Link the agent definitions into the pi agent dir and register this repo as a pi package.
# Safe to run twice.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$agent_dir/agents"
for f in "$repo"/agents/*.md; do
  target="$agent_dir/agents/$(basename "$f")"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip $target (exists and is not a symlink)" >&2
    continue
  fi
  ln -sfn "$f" "$target"
  echo "linked $target"
done

if command -v pi >/dev/null 2>&1; then
  pi install "$repo"
else
  echo "pi not on PATH. Add this to $agent_dir/settings.json under packages: \"$repo\"" >&2
fi
