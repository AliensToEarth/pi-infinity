#!/usr/bin/env bash
set -euo pipefail
name="$(node -p 'encodeURIComponent(require("./package.json").name)')"
version="$(node -p 'encodeURIComponent(require("./package.json").version)')"
status="$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$name/$version")"
case "$status" in
  200) echo "Package version is already published; skipping." ;;
  404) npm publish --access public ;;
  *) echo "npm registry returned HTTP $status; refusing to publish." >&2; exit 1 ;;
esac
