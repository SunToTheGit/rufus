#!/usr/bin/env bash
# Rufus installer. Drops the Rufus subagent into ~/.claude/agents/ so any
# Claude Code session on this machine can run it via natural language
# ("run rufus", "rufus audit", "rufus loop", etc.).
#
# Usage on a fresh Mac:
#   curl -fsSL https://raw.githubusercontent.com/SunToTheGit/rufus/main/install.sh | bash
#
# Or from a local clone:
#   ./agents/install.sh

set -euo pipefail

AGENTS_DIR="${HOME}/.claude/agents"
TARGET="${AGENTS_DIR}/rufus.md"
SOURCE_URL="https://raw.githubusercontent.com/SunToTheGit/rufus/main/rufus.md"

mkdir -p "${AGENTS_DIR}"

if [ -f "$(dirname "$0")/rufus.md" ]; then
  # Running from a local clone — copy.
  cp "$(dirname "$0")/rufus.md" "${TARGET}"
  echo "✓ installed Rufus from local clone → ${TARGET}"
else
  # Running via curl-pipe — fetch.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${SOURCE_URL}" -o "${TARGET}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "${TARGET}" "${SOURCE_URL}"
  else
    echo "✗ Need curl or wget to fetch from ${SOURCE_URL}" >&2
    exit 1
  fi
  echo "✓ installed Rufus from ${SOURCE_URL} → ${TARGET}"
fi

echo
echo "Done. Try in any Claude Code session in any project:"
echo
echo "    run rufus"
echo "    run rufus audit"
echo "    run rufus implement"
echo
echo "Rufus auto-detects the project (TypeScript / Expo / Rust / Go / Python)"
echo "and ships a design audit + implementation pass. No gstack required."
