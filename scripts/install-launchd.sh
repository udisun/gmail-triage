#!/bin/bash
# Generates the launchd plist from launchd/*.plist.template and (unless --no-load) reloads it.
# Usage: scripts/install-launchd.sh [--dest <dir>] [--no-load]
set -euo pipefail

LABEL="${GMAIL_TRIAGE_LABEL:-local.gmail-triage}"
[[ "$LABEL" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$ ]] || { echo "GMAIL_TRIAGE_LABEL must be letters, digits, dots and dashes" >&2; exit 2; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents"
LOAD=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a directory}"; shift 2 ;;
    --no-load) LOAD=0; shift ;;
    *) echo "usage: $0 [--dest <dir>] [--no-load]" >&2; exit 2 ;;
  esac
done

# command -v keeps relative PATH entries; launchd needs absolute, canonical-directory paths.
absolute() {
  local p dir
  p="$(command -v "$1" || true)"
  [[ -n "$p" && -x "$p" ]] || { echo "$1 not found on PATH" >&2; return 1; }
  dir="$(cd "$(dirname "$p")" && pwd -P)"
  printf '%s/%s' "$dir" "$(basename "$p")"
}
NODE="$(absolute node)" || exit 1
CLAUDE="$(absolute claude)" || exit 1

xml() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; s="${s//\"/&quot;}"; s="${s//\'/&apos;}"
  printf '%s' "$s"
}

# No ANTHROPIC_* or CLAUDE_CONFIG_DIR: subscription auth works with a minimal env.
export X_NODE X_REPO X_PATH X_LOG X_EXTRA X_LABEL
X_LABEL="$LABEL"
X_NODE="$(xml "$NODE")"
X_REPO="$(xml "$REPO")"
X_PATH="$(xml "$(dirname "$NODE"):$(dirname "$CLAUDE"):/usr/bin:/bin:/usr/sbin:/sbin")"
X_LOG="$(xml "$HOME/Library/Logs/gmail-triage.log")"
# CLAUDE_BIN pins the exact install, so a reordered PATH cannot pick another claude
X_EXTRA="
    <key>CLAUDE_BIN</key>
    <string>$(xml "$CLAUDE")</string>"
if [[ -n "${GMAIL_TRIAGE_HOME:-}" ]]; then
  X_EXTRA="$X_EXTRA
    <key>GMAIL_TRIAGE_HOME</key>
    <string>$(xml "$GMAIL_TRIAGE_HOME")</string>"
fi

mkdir -p "$DEST"
PLIST="$DEST/$LABEL.plist"
TMP="$PLIST.tmp.$$"
trap 'rm -f "$TMP"' EXIT
# perl reads values from env, so & and \ in paths are never treated as replacement syntax
/usr/bin/perl -pe 's/__NODE__/$ENV{X_NODE}/g; s/__REPO__/$ENV{X_REPO}/g; s/__PATH__/$ENV{X_PATH}/g; s/__LOG__/$ENV{X_LOG}/g; s/__EXTRA_ENV__/$ENV{X_EXTRA}/g; s/__LABEL__/$ENV{X_LABEL}/g' \
  "$REPO/launchd/gmail-triage.plist.template" > "$TMP"
/usr/bin/plutil -lint "$TMP" >/dev/null || { echo "generated plist failed plutil -lint" >&2; exit 1; }
mv "$TMP" "$PLIST"
echo "wrote $PLIST"

[[ "$LOAD" -eq 1 ]] || exit 0

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in $(seq 1 50); do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.2
done
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "$LABEL is still loaded after bootout" >&2
  exit 1
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "loaded $LABEL"
