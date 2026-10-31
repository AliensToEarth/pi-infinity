#!/usr/bin/env bash
# Single quality gate. Run before every commit.
# Formatting failures print one hint instead of a diff, so nobody (human or agent)
# edits by hand what `npm run fmt` fixes.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '== %s\n' "$1"; }

step "dependencies"
[ -d node_modules ] || npm ci

step "format"
if ! npx --no-install prettier --check . >/dev/null 2>&1; then
  echo "formatting differs. Run: npm run fmt"
  exit 1
fi

step "typecheck"
npx --no-install tsc --noEmit -p tsconfig.json

step "tests"
node --test test/*.test.ts

echo "check.bash OK"
