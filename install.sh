#!/bin/sh
# ===========================================================================
# The Diff Bits — installer.
#
#   curl -fsSL https://bits.the-diff.com/install.sh | sh
#
# Adds a content segment to your Claude Code status line. Backs up and SAFELY
# MERGES your ~/.claude/settings.json (never clobbers an existing statusLine).
# Uninstall anytime:
#   curl -fsSL https://bits.the-diff.com/uninstall.sh | sh
# ===========================================================================
set -eu

BASE="${DIFF_BITS_BASE_URL:-https://bits.the-diff.com}"
BASE="${BASE%/}"
# The client code is fetched from a PINNED commit/tag on GitHub — not from the
# website — so what you run matches the public, auditable repo exactly. GH_REF
# is stamped at release time; bits.the-diff.com/install.sh redirects here.
GH_REF="client-v0.1.13"
GH_RAW="https://raw.githubusercontent.com/jaryd-hermann/diff-bits-client/${GH_REF}"
REF="${DIFF_BITS_REF:-}"          # install source/campaign (the /install.sh route may inject this)
DIR="${DIFF_BITS_DIR:-$HOME/.the-diff/bits}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
COMMAND='node ~/.the-diff/bits/bits.mjs'

# ── pretty output ──────────────────────────────────────────────────────────
g() { printf '\033[38;2;52;193;115m%s\033[0m' "$1"; }   # green
bold() { printf '\033[1m%s\033[0m' "$1"; }
say() { printf '%s\n' "$1"; }
die() { printf '\n\033[38;2;242;90;90m✗ %s\033[0m\n' "$1" >&2; exit 1; }

printf '\n  %s %s\n\n' "$(g '●')" "$(bold 'The Diff Bits — installer')"

# ── 1. Node >= 18 ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  die "Node.js (>= 18) is required but was not found.
    Install it from https://nodejs.org and re-run this installer.
    (We never auto-install anything on your machine.)"
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  die "Node.js >= 18 is required (found $(node -v 2>/dev/null)). Please upgrade and re-run."
fi

# ── 2. Create dir, download client, generate install_id ────────────────────
mkdir -p "$DIR"

say "  → downloading client (bits.mjs) from the pinned GitHub commit…"
if ! curl -fsSL "$GH_RAW/bits.mjs" -o "$DIR/bits.mjs.new"; then
  die "Failed to download the client from $GH_RAW/bits.mjs"
fi
# Sanity check it's the real script before swapping it in.
if ! head -n 5 "$DIR/bits.mjs.new" | grep -q "The Diff Bits"; then
  rm -f "$DIR/bits.mjs.new"
  die "Downloaded client failed a sanity check; aborting (your config is untouched)."
fi
mv "$DIR/bits.mjs.new" "$DIR/bits.mjs"

# Preserve an existing install_id across re-installs.
if [ ! -s "$DIR/install_id" ]; then
  node -e 'process.stdout.write(require("crypto").randomUUID())' > "$DIR/install_id"
fi
INSTALL_ID=$(cat "$DIR/install_id")
CLIENT_VERSION=$(node "$DIR/bits.mjs" --version 2>/dev/null || echo "unknown")

# ── 3. Back up + safely merge ~/.claude/settings.json ──────────────────────
mkdir -p "$CLAUDE_DIR"
if [ -f "$SETTINGS" ]; then
  STAMP=$(date +%Y%m%d%H%M%S)
  cp "$SETTINGS" "$SETTINGS.bits-backup.$STAMP"
  say "  → backed up settings.json → settings.json.bits-backup.$STAMP"
fi

# The merge is done in Node (already required above) so it is bulletproof JSON,
# not fragile sed/jq. It preserves any existing statusLine as statusLine_prev.
MERGE_JS="$DIR/.merge.mjs"
cat > "$MERGE_JS" <<'NODE'
import fs from "node:fs";
const [settingsPath, command] = [process.env.SETTINGS, process.env.COMMAND];
// refreshInterval re-runs the status line every N seconds even while the
// session is idle, so bits visibly rotate while you read — not only on new
// messages. An impression = time a bit is on a live session's screen.
const ours = { type: "command", command, padding: 0, refreshInterval: 8 };
const isOurs = (sl) =>
  sl && typeof sl === "object" && typeof sl.command === "string" &&
  sl.command.includes(".the-diff/bits/bits.mjs");

let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (raw) {
    try { settings = JSON.parse(raw); }
    catch {
      console.error("EINVALID"); // settings.json exists but isn't valid JSON
      process.exit(3);
    }
  }
}
if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
  console.error("EINVALID");
  process.exit(3);
}

let warned = "";
if (settings.statusLine && !isOurs(settings.statusLine)) {
  settings.statusLine_prev = settings.statusLine; // preserve the user's line
  warned = "PREV";
}
settings.statusLine = ours;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(warned);
NODE

set +e
MERGE_OUT=$(SETTINGS="$SETTINGS" COMMAND="$COMMAND" node "$MERGE_JS" 2>&1)
MERGE_CODE=$?
set -e
rm -f "$MERGE_JS"

if [ "$MERGE_CODE" -eq 3 ]; then
  die "Your $SETTINGS exists but isn't valid JSON. We did NOT modify it.
    Fix or remove it, then re-run. (A backup was made if the file was present.)"
elif [ "$MERGE_CODE" -ne 0 ]; then
  die "Failed to update settings.json (exit $MERGE_CODE). Your config is unchanged or restorable from the backup."
fi

if [ "$MERGE_OUT" = "PREV" ]; then
  printf '  %s you already had a statusLine — we saved it as %s in settings.json.\n' \
    "$(g '!')" "$(bold 'statusLine_prev')"
fi

# ── 4. Topic selection (interactive when a terminal is available) ──────────
# Bits span topics — pick interests, or take them all. Works through
# `curl … | sh` by reading the controlling terminal (/dev/tty); falls back to
# "all" when there's no TTY (CI, non-interactive). Honors DIFF_BITS_TOPICS.
TOPICS_CSV="${DIFF_BITS_TOPICS:-}"
if [ -z "$TOPICS_CSV" ] && [ -r /dev/tty ]; then
  say ""
  say "  $(bold 'Pick your topics') (press Enter for all):"
  say "    1) AI         2) Tech       3) Business   4) Startups"
  say "    5) Science    6) Finance    7) Politics   8) World"
  say "    9) Product Hunt Launches"
  printf '  > e.g. 1,2,5 (Enter for all): '
  read -r PICK < /dev/tty || PICK=""
  TOPICS_CSV=$(node -e '
    const map={1:"ai",2:"tech",3:"business",4:"startups",5:"science",6:"finance",7:"politics",8:"world",9:"producthunt"};
    const raw=(process.argv[1]||"").trim();
    if(!raw){process.stdout.write("");process.exit(0);}
    const out=[...new Set(raw.split(/[, ]+/).map(s=>map[s.trim()]||(Object.values(map).includes(s.trim())?s.trim():"")).filter(Boolean))];
    process.stdout.write(out.join(","));
  ' "$PICK")
fi
printf '%s' "$TOPICS_CSV" > "$DIR/topics"   # empty = all topics
if [ -n "$TOPICS_CSV" ]; then
  say "  $(g '●') topics: $TOPICS_CSV"
else
  say "  $(g '●') topics: all"
fi

# Install a /bits-topics slash command so topics can be changed anytime from
# inside Claude Code (it just runs the client's --topics subcommand).
CMD_DIR="$CLAUDE_DIR/commands"
if mkdir -p "$CMD_DIR" 2>/dev/null; then
  cat > "$CMD_DIR/bits-topics.md" <<'CMD'
---
description: Change your Diff Bits topics (e.g. /bits-topics ai,tech — or "all" for everything)
argument-hint: "[topics]"
---

!`node ~/.the-diff/bits/bits.mjs --topics $ARGUMENTS`
CMD
  say "  $(g '●') /bits-topics command installed (change topics anytime)"
fi

# ── 5. Register the install (best-effort; never fails the install) ─────────
OS=$(uname -s 2>/dev/null || echo unknown)
ARCH=$(uname -m 2>/dev/null || echo unknown)
CC_VERSION=$(claude --version 2>/dev/null | head -n1 || echo "")
BODY=$(node -e '
  const [id, os, arch, cc, cv, ref, topics] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    install_id: id, os, arch, cc_version: cc || null,
    client_version: cv, surface: "cli", source: ref || null,
    topics: topics ? topics.split(",").filter(Boolean) : []
  }));
' "$INSTALL_ID" "$OS" "$ARCH" "$CC_VERSION" "$CLIENT_VERSION" "$REF" "$TOPICS_CSV")
curl -fsS -X POST "$BASE/api/install" \
  -H 'content-type: application/json' \
  --data "$BODY" >/dev/null 2>&1 || say "  $(g '·') (couldn't reach the server to register — that's fine, it'll register on first sync)"

# ── 6. Editor extension (Cursor / VS Code) — one command installs both ─────
# Find an editor CLI, even when it isn't on PATH (common with Cursor): check
# PATH first, then standard app-bundle / install locations on macOS & Linux.
ED_BIN=""
ED_NAME=""
for c in cursor code; do
  if command -v "$c" >/dev/null 2>&1; then
    ED_BIN=$(command -v "$c"); ED_NAME="$c"; break
  fi
done
if [ -z "$ED_BIN" ]; then
  for p in \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/usr/share/cursor/bin/cursor" \
    "/usr/share/code/bin/code" \
    "/snap/bin/code"; do
    if [ -x "$p" ]; then
      ED_BIN="$p"
      case "$p" in *cursor*) ED_NAME="Cursor" ;; *) ED_NAME="VS Code" ;; esac
      break
    fi
  done
fi
if [ -n "$ED_BIN" ]; then
  say "  → installing the $ED_NAME extension…"
  if curl -fsSL "$BASE/vsix" -o "$DIR/diff-bits.vsix" 2>/dev/null &&
     "$ED_BIN" --install-extension "$DIR/diff-bits.vsix" >/dev/null 2>&1; then
    say "  $(g '✓') $ED_NAME extension installed (reload $ED_NAME to see it)"
  else
    say "  $(g '·') (couldn't auto-install the $ED_NAME extension — skipping)"
  fi
else
  say "  $(g '·') (no Cursor / VS Code found — terminal client installed; skipping editor extension)"
fi

# ── 7. Done ────────────────────────────────────────────────────────────────
say ""
say "  $(g '✓') Installed. Bits will appear in your Claude Code status line during wait states."
say ""
say "    $(bold 'Restart Claude Code') (or start a new session) to see it."
say ""
say "    Change topics anytime:  $(bold '/bits-topics ai,tech')  (or \"all\")"
say ""
say "    Uninstall anytime:"
say "      curl -fsSL $BASE/uninstall.sh | sh"
say ""
