#!/usr/bin/env bash
# Compatibility wrapper; pi-infinity configures its bundled agents at startup.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
exec pi install "$repo"
