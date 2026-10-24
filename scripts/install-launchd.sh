#!/usr/bin/env bash
# Install the homeling persona daemon as a launchd user agent (ADR-0001).
# RunAtLoad + KeepAlive, logs to ~/.local/share/homeling/log/daemon.{out,err}.log.
#
# Idempotent: re-running overwrites the plist and reloads the agent.
# Never touches ~/Library/LaunchAgents/herdr.collie.plist (zero-touch, ADR-0004).
#
# Environment overrides (all optional):
#   HOMELING_REPO          repo root (default: this script's repo)
#   HOMELING_PORT          listen port (default 8790)
#   HOMELING_TRUSTED_USERS comma-separated tailscale logins
#   HOMELING_TAILSCALE_HOST this node's tailscale DNS name
#   HOMELING_PUBLIC_ORIGIN canonical HTTPS origin for sessions and writes
set -euo pipefail

REPO="${HOMELING_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
LABEL="com.homeling.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.local/share/homeling/log"
BUN="$(command -v bun)"
DAEMON_ENTRY="$REPO/apps/daemon/src/index.ts"

[ -x "$BUN" ] || { echo "[install-launchd] bun not found in PATH" >&2; exit 1; }
[ -f "$DAEMON_ENTRY" ] || { echo "[install-launchd] daemon entry not found: $DAEMON_ENTRY" >&2; exit 1; }

ENV_DICT=""
add_env() { ENV_DICT="$ENV_DICT    <key>$1</key><string>$2</string>"$'\n'; }
add_env HOMELING_PORT "${HOMELING_PORT:-8790}"
[ -n "${HOMELING_TRUSTED_USERS:-}" ] && add_env HOMELING_TRUSTED_USERS "$HOMELING_TRUSTED_USERS"
[ -n "${HOMELING_TAILSCALE_HOST:-}" ] && add_env HOMELING_TAILSCALE_HOST "$HOMELING_TAILSCALE_HOST"
[ -n "${HOMELING_PUBLIC_ORIGIN:-}" ] && add_env HOMELING_PUBLIC_ORIGIN "$HOMELING_PUBLIC_ORIGIN"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

# Unload the existing agent first so the reload below picks up the new plist.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>run</string>
    <string>$DAEMON_ENTRY</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
$ENV_DICT  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/daemon.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/daemon.err.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "[install-launchd] installed $PLIST"
echo "[install-launchd] logs: $LOG_DIR/daemon.{out,err}.log"
echo "[install-launchd] note: herdr.collie.plist untouched"

# Run from the repository root: bash scripts/install-launchd.sh
