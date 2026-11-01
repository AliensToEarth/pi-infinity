#!/usr/bin/env bash
# Retry removal because processes in the smoke session may finish writing as tmux exits.
smoke_remove_work() {
  local work="$1" attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if rm -rf "$work" 2>/dev/null; then return 0; fi
    if [ "$attempt" -lt 10 ]; then sleep 1; fi
  done
  echo "FAIL: could not remove smoke directory: $work" >&2
  return 1
}
