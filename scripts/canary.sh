#!/usr/bin/env bash
# Canary for the zero-touch invariant (ADR-0004): Homeling must never touch the Collie
# checkout or its tailscale serve root handler.
#
# Two-phase:
#   canary.sh save   — before a deploy, snapshot the protected state.
#   canary.sh check  — after a deploy (and any time), compare against the snapshot.
#
# Checked invariants:
#   1. `git -C ~/.local/share/collie status --porcelain` is empty.
#   2. `bin/collie` mtime + sha256 are unchanged (the binary was not rebuilt/replaced).
#   3. `tailscale serve` root handler `/` still proxies to :8787 (never rewritten).
#
# Optional health request runs only with HOMELING_CANARY_DAEMON_URL set.
# This script does not restart the daemon or verify that a restart occurred.
set -uo pipefail

COLLIE_DIR="${COLLIE_DIR:-$HOME/.local/share/collie}"
SERVE_ROOT_PROXY="${SERVE_ROOT_PROXY:-http://127.0.0.1:8787}"
STATE_FILE="${HOMELING_CANARY_STATE:-${TMPDIR:-/tmp}/homeling-canary-state.env}"

fail() { echo "[canary] FAIL: $*" >&2; exit 1; }

snap() {
  git -C "$COLLIE_DIR" rev-parse HEAD 2>/dev/null || echo "no-git"
}

collie_fingerprint() {
  local bin="$COLLIE_DIR/bin/collie"
  [ -f "$bin" ] || { echo "missing"; return; }
  local modified
  # GNU stat may emit filesystem details before rejecting BSD flags; discard that failed probe.
  if ! modified=$(stat -f %m "$bin" 2>/dev/null); then
    modified=$(stat -c %Y "$bin")
  fi
  echo "$modified $(shasum -a 256 "$bin" | cut -d' ' -f1)"
}

valid_authority() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*:443$ ]]
}

root_handler() {
  tailscale serve status --json 2>/dev/null | bun -e '
    const { parseServeStatusRootProxy } = await import(process.argv[1]);
    const root = parseServeStatusRootProxy(await new Response(Bun.stdin.stream()).text(), process.argv[2]);
    if (!root) process.exit(1);
    console.log(root);
  ' "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../apps/daemon/src" && pwd)/canary.ts" "$1"
}

cmd_save() {
  [ -d "$COLLIE_DIR" ] || fail "collie dir not found: $COLLIE_DIR"
  local authority="${HOMELING_CANARY_SERVE_AUTHORITY:-}"
  valid_authority "$authority" || fail "HOMELING_CANARY_SERVE_AUTHORITY must be the protected DNS:443 key"
  local root; root=$(root_handler "$authority")
  [ -n "$root" ] || fail "cannot read the protected tailscale serve root handler"
  [ "$root" = "$SERVE_ROOT_PROXY" ] || fail "root handler does not match the protected proxy"
  cat > "$STATE_FILE" <<EOF
COLLIE_HEAD='$(snap)'
COLLIE_BIN='$(collie_fingerprint)'
SERVE_AUTHORITY='$authority'
ROOT_HANDLER='$root'
EOF
  echo "[canary] saved state to $STATE_FILE"
  echo "[canary]   collie HEAD: $(snap)"
  echo "[canary]   bin/collie:  $(collie_fingerprint)"
  echo "[canary]   root /:      $root"
}

cmd_check() {
  [ -f "$STATE_FILE" ] || fail "no saved state at $STATE_FILE — run 'canary.sh save' first"
  local SERVE_AUTHORITY="" ROOT_HANDLER=""
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  valid_authority "$SERVE_AUTHORITY" || fail "saved protected DNS:443 key missing or invalid; save a new baseline"
  [ -n "$ROOT_HANDLER" ] || fail "saved root handler missing"
  if [ -n "${HOMELING_CANARY_SERVE_AUTHORITY:-}" ] && [ "$HOMELING_CANARY_SERVE_AUTHORITY" != "$SERVE_AUTHORITY" ]; then
    fail "protected serve authority differs from saved baseline"
  fi

  local rc=0

  local dirty; dirty=$(git -C "$COLLIE_DIR" status --porcelain 2>/dev/null) || fail "cannot read collie checkout status"
  if [ -n "$dirty" ]; then
    echo "[canary] FAIL: collie checkout is dirty:"
    echo "$dirty" | sed 's/^/[canary]   /'
    rc=1
  else
    echo "[canary] ok: collie checkout clean"
  fi

  local now_bin; now_bin=$(collie_fingerprint)
  if [ "$now_bin" != "$COLLIE_BIN" ]; then
    echo "[canary] FAIL: bin/collie changed:"
    echo "[canary]   was: $COLLIE_BIN"
    echo "[canary]   now: $now_bin"
    rc=1
  else
    echo "[canary] ok: bin/collie untouched"
  fi

  local now_root; now_root=$(root_handler "$SERVE_AUTHORITY") || fail "cannot read the saved protected root handler"
  if [ "$now_root" != "$ROOT_HANDLER" ]; then
    echo "[canary] FAIL: tailscale serve root handler changed:"
    echo "[canary]   was: $ROOT_HANDLER"
    echo "[canary]   now: $now_root"
    rc=1
  else
    echo "[canary] ok: root handler $now_root"
  fi

  if [ -n "${HOMELING_CANARY_DAEMON_URL:-}" ]; then
    if curl -fsS --max-time 5 "$HOMELING_CANARY_DAEMON_URL/lite/api/health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      echo "[canary] ok: daemon /lite/api/health responds"
    else
      echo "[canary] FAIL: daemon not healthy at $HOMELING_CANARY_DAEMON_URL"
      rc=1
    fi
  fi

  if [ "$rc" -eq 0 ]; then echo "[canary] all invariants hold"; else echo "[canary] INVARIANT VIOLATION"; fi
  exit "$rc"
}

case "${1:-}" in
  save) cmd_save ;;
  check) cmd_check ;;
  *) echo "usage: canary.sh save|check" >&2; exit 2 ;;
esac
