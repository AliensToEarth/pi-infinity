#!/usr/bin/env bash
set +x
set -euo pipefail
: "${NODE_AUTH_TOKEN:?GitHub Packages token is required}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
version="$(node -p 'require("./package.json").version')"
status="$(printf 'Authorization: Bearer %s\n' "$NODE_AUTH_TOKEN" | curl -sS --connect-timeout 10 --max-time 30 -H @- -o "$dir/metadata.json" -w '%{http_code}' 'https://npm.pkg.github.com/@alienstoearth%2Fpi-infinity')"
case "$status" in
  200)
    if node -e 'try { const m = require(process.argv[1]); if (!m.versions || typeof m.versions !== "object" || Array.isArray(m.versions)) throw new Error("invalid registry metadata"); process.exit(Object.hasOwn(m.versions, process.argv[2]) ? 0 : 1); } catch (err) { console.error(err); process.exit(2); }' "$dir/metadata.json" "$version"; then
      echo "GitHub package version is already published; skipping."
      exit 0
    else
      result=$?
      if [ "$result" -ne 1 ]; then exit "$result"; fi
    fi
    ;;
  404) ;;
  *) echo "GitHub Packages returned HTTP $status; refusing to publish." >&2; exit 1 ;;
esac
npm pack --ignore-scripts --pack-destination "$dir" >/dev/null
tar -xzf "$dir"/*.tgz -C "$dir"
node -e 'const fs = require("node:fs"); const path = process.argv[1]; const pkg = JSON.parse(fs.readFileSync(path, "utf8")); pkg.name = "@alienstoearth/pi-infinity"; fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n")' "$dir/package/package.json"
(cd "$dir/package" && npm publish --ignore-scripts --registry https://npm.pkg.github.com)
