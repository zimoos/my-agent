#!/usr/bin/env bash
set -euo pipefail

# Thin compatibility wrapper. The old expect-based prompt matcher was tied to a
# stale TUI prompt and could fail before user input was sent.

cd "$(dirname "$0")/.."
exec npm run e2e:real -- "$@"
