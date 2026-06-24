#!/bin/sh
# ===========================================================================
# The Diff Bits — uninstaller. One command, no residue.
#
#   curl -fsSL https://bits.the-diff.com/uninstall.sh | sh
#
# Restores your previous status line (statusLine_prev) if we saved one, or
# removes our statusLine block; then deletes ~/.the-diff/bits/. Leaves every
# other setting untouched.
# ===========================================================================
set -eu

DIR="${DIFF_BITS_DIR:-$HOME/.the-diff/bits}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"

g() { printf '\033[38;2;52;193;115m%s\033[0m' "$1"; }
bold() { printf '\033[1m%s\033[0m' "$1"; }
say() { printf '%s\n' "$1"; }

printf '\n  %s %s\n\n' "$(g '●')" "$(bold 'The Diff Bits — uninstaller')"

# ── 1. Restore / remove our statusLine (Node = bulletproof JSON) ───────────
if [ -f "$SETTINGS" ] && command -v node >/dev/null 2>&1; then
  cp "$SETTINGS" "$SETTINGS.bits-uninstall-backup.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  CLEAN_JS="${TMPDIR:-/tmp}/.bits-uninstall.$$.mjs"
  cat > "$CLEAN_JS" <<'NODE'
import fs from "node:fs";
const p = process.env.SETTINGS;
const isOurs = (sl) =>
  sl && typeof sl === "object" && typeof sl.command === "string" &&
  sl.command.includes(".the-diff/bits/bits.mjs");
let s;
try { s = JSON.parse(fs.readFileSync(p, "utf8")); }
catch { process.exit(0); } // not valid JSON — leave it entirely alone
if (s && typeof s === "object") {
  if (isOurs(s.statusLine)) {
    if (s.statusLine_prev !== undefined) {
      s.statusLine = s.statusLine_prev;   // restore what the user had
      delete s.statusLine_prev;
    } else {
      delete s.statusLine;                // we were the only statusLine
    }
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
    console.log("CLEANED");
  } else if (s.statusLine_prev !== undefined) {
    delete s.statusLine_prev;
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  }
}
NODE
  OUT=$(SETTINGS="$SETTINGS" node "$CLEAN_JS" 2>/dev/null || true)
  rm -f "$CLEAN_JS"
  if [ "$OUT" = "CLEANED" ]; then
    say "  $(g '✓') restored your previous status line in settings.json"
  else
    say "  $(g '·') no Diff Bits statusLine found in settings.json (left untouched)"
  fi
fi

# ── 2. Remove our files ────────────────────────────────────────────────────
if [ -d "$DIR" ]; then
  rm -rf "$DIR"
  say "  $(g '✓') removed $DIR"
fi
# Remove the parent ~/.the-diff if it's now empty.
PARENT=$(dirname "$DIR")
if [ -d "$PARENT" ]; then
  rmdir "$PARENT" 2>/dev/null || true
fi

say ""
say "  $(g '✓') Uninstalled. Restart Claude Code to apply. Thanks for trying Bits."
say ""
