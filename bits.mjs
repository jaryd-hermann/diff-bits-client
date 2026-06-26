#!/usr/bin/env node
// ===========================================================================
// The Diff Bits — Claude Code status-line client.
//
// Self-contained, zero runtime deps (Node >= 18 built-ins only). Two modes:
//
//   node bits.mjs            HOT PATH. Runs every ~300ms as Claude Code's
//                            statusLine command. Must be fast and must NEVER
//                            break Claude Code: any error degrades to a safe
//                            line (or nothing) and exits clean.
//
//   node bits.mjs --sync     BACKGROUND. Spawned detached off the hot path.
//                            Refreshes the feed cache and flushes queued
//                            impression/click events to the server.
//
// TRUST GUARANTEE: we read the session JSON Claude Code pipes us (to show your
// git branch etc.) and a local cache file. We never read your code, prompts,
// files, or the AI's responses, and we never write anything outside
// ~/.the-diff/bits/. The whole client is open source — verify it.
// ===========================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────
const CLIENT_VERSION = "0.1.13";
const DEFAULT_BASE = "https://bits.the-diff.com";
// DIFF_BITS_BASE_URL / DIFF_BITS_DIR let the test harness point elsewhere.
const BASE = (process.env.DIFF_BITS_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
const DIR =
  process.env.DIFF_BITS_DIR || path.join(os.homedir(), ".the-diff", "bits");

const INSTALL_ID_FILE = path.join(DIR, "install_id");
const CACHE_FILE = path.join(DIR, "cache.json");
const STATE_FILE = path.join(DIR, "state.json");
const TOPICS_FILE = path.join(DIR, "topics"); // comma-separated; written at install

const MAX_QUEUE = 500; // cap pending events so an offline client can't grow unbounded
const LIVE_GAP_MS = 12000; // gap larger than this => the session paused (closed/slept); must exceed statusLine refreshInterval (8s) so idle heartbeats still chain
const AGENT_IDLE_MS = 900000; // pause counting after 15 min with no agent activity (reading still counts up to here); resume when the agent next works
const MAX_COLS = 118; // keep the rendered line comfortably under a terminal width
const MIN_BIT_COLS = 24; // never truncate a bit below this many visible chars
const MARKER = "✱"; // heavy asterisk

const DEFAULT_SETTINGS = {
  // dwell_ms: minimum on-screen time a selection must accrue before it (a)
  // counts as an impression and (b) becomes eligible to rotate at a burst
  // boundary. Below this, a bit is "not seen enough yet" and is kept.
  dwell_ms: 4000,
  // max_dwell_ms: wall-clock time a bit stays on screen before rotating to the
  // next one (while Claude Code is re-rendering). Served by the feed, so this
  // is just the pre-first-sync fallback.
  max_dwell_ms: 30000,
  refresh_min: 30,
  flush_threshold: 20,
};

const useColor = !process.env.NO_COLOR;
const green = (s) => (useColor ? `[38;2;52;193;115m${s}[0m` : s);

// Style the linked bit text as GREEN + underlined so it reads as a link in
// every terminal. We color the *foreground* (SGR 38) rather than the underline
// (SGR 58), because the Claude Code desktop terminal (xterm.js, non-WebGL
// renderer) drops underline-color and draws the underline in the text color —
// so green text gives a green underline everywhere. Plain `4` underline is used
// (styled `4:4` dotted is unsupported in that renderer and falls back to solid).
// (ESC via fromCharCode to keep the byte explicit.)
const ESC = String.fromCharCode(27);
const underline = (s) =>
  useColor
    ? `${ESC}[38;2;52;193;115m${ESC}[4m${s}${ESC}[24m${ESC}[39m`
    : s;
// Sponsored-content disclosure tag (brand orange). Kept short + always shown
// for sponsor bits so the placement is clearly labeled.
const orange = (s) => (useColor ? `${ESC}[38;2;232;161;60m${s}${ESC}[39m` : s);
// Brand lavender (#C9A6F5) — used for the ✱ marker bullet.
const lavender = (s) => (useColor ? `${ESC}[38;2;201;166;245m${s}${ESC}[39m` : s);

// ── Tiny safe IO helpers (never throw) ──────────────────────────────────────
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Atomic write: tmp file + rename. With two writers (hot path + --sync) this
// guarantees no torn reads; the worst case is a lost update, never corruption.
function writeJsonAtomic(file, obj) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch {
    // Swallow — failing to persist state must never break the status line.
  }
}

function readStdinJson() {
  try {
    // Synchronous read of fd 0 — Claude Code pipes the session JSON and closes.
    const raw = fs.readFileSync(0, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function getInstallId() {
  try {
    const id = fs.readFileSync(INSTALL_ID_FILE, "utf8").trim();
    if (id) return id;
  } catch {
    /* fall through to generate */
  }
  // install.sh normally creates this; regenerate defensively if missing.
  const id = randomUUID();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(INSTALL_ID_FILE, id);
  } catch {
    /* ignore */
  }
  return id;
}

function freshState() {
  return {
    current_bit_id: null,
    last_bit_id: null, // for no-back-to-back-repeat
    bit_started_at: null, // ms when the current bit became current (selection start)
    bit_total_ms: 0, // attested on-screen time accrued for the current selection
    seg_accrued_ms: 0, // attested time in the current continuous segment (resets on gap)
    last_tick_at: null,
    last_fp: null, // last agent-activity fingerprint (to detect when it changes)
    last_active_at: null, // ms of the last tick the agent did work
    queue: [], // FIFO of pending {type, bit_id, ts, dwell_ms?}
    cc_version: null,
    shown_count: 0, // total bits shown — drives the 1-in-5 sponsor cadence
  };
}

// Agent-activity fingerprint: session usage fields that advance whenever Claude
// Code does work (cost, tokens, context %). A CHANGE between ticks means the
// agent just ran. We use this only to detect IDLE — counting keeps going for
// AGENT_IDLE_MS after the last activity (so reading the agent's output counts),
// then pauses until the agent runs again. Returns null if no field is present.
function activityFingerprint(session) {
  const cw = session?.context_window;
  const parts = [
    session?.cost?.total_cost_usd,
    session?.cost?.total_api_duration_ms,
    session?.cost?.total_lines_added,
    session?.cost?.total_lines_removed,
    cw?.total_input_tokens,
    cw?.total_output_tokens,
    cw?.used_percentage,
  ].filter((v) => v !== undefined && v !== null);
  return parts.length ? parts.join("|") : null;
}

// Begin showing `bit`: it's now the current selection with a fresh clock.
function startSelection(state, bit, now) {
  state.current_bit_id = bit.id;
  state.bit_started_at = now;
  state.bit_total_ms = 0;
  state.seg_accrued_ms = 0;
  state.shown_count = (state.shown_count || 0) + 1;
}

// A selection is over (rotating away, or the bit vanished from the feed). Emit
// exactly ONE impression for it — carrying its TOTAL attested on-screen time —
// provided it was shown long enough to count. This is what powers both the
// "did it show" signal and the cumulative display-time ticker (sum of dwell_ms
// per bit) in the dashboard.
function finalizeSelection(state, settings, now) {
  if (state.current_bit_id && state.bit_total_ms >= settings.dwell_ms) {
    enqueue(state, {
      type: "impression",
      bit_id: state.current_bit_id,
      ts: new Date(state.bit_started_at || now).toISOString(),
      dwell_ms: Math.round(state.bit_total_ms),
    });
  }
}

// ── Session JSON helpers (best effort, all degrade to null) ─────────────────
function sessionCwd(session) {
  return (
    session?.cwd ||
    session?.workspace?.current_dir ||
    session?.workspace?.project_dir ||
    null
  );
}

// Read the current git branch from .git/HEAD — a cheap local file read, never
// a `git` subprocess (which would be far too slow for the hot path).
function gitBranch(session) {
  try {
    const cwd = sessionCwd(session);
    if (!cwd) return null;
    let dir = cwd;
    // Walk up to find a .git directory (handles subdirectories of a repo).
    for (let i = 0; i < 12; i++) {
      const head = path.join(dir, ".git", "HEAD");
      try {
        const ref = fs.readFileSync(head, "utf8").trim();
        const m = ref.match(/^ref:\s*refs\/heads\/(.+)$/);
        return m ? m[1] : ref.slice(0, 7); // detached HEAD -> short sha
      } catch {
        /* not here, walk up */
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Context-window percentage, if the session JSON exposes it. Field names have
// varied across Claude Code versions; try the known candidates and otherwise
// omit it rather than show something wrong.
function ctxPct(session) {
  const cands = [
    session?.context_window?.used_percentage, // current Claude Code schema
    session?.context?.used_percent, // legacy fallbacks (older versions)
    session?.context?.percent_used,
    session?.context_window?.used_percent,
  ];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n);
  }
  return null;
}

function modelName(session) {
  return session?.model?.display_name || session?.model?.id || null;
}

// ── Bit selection ───────────────────────────────────────────────────────────
// Weighted random pick, avoiding an immediate repeat of `avoidId` when possible.
function pickWeighted(bits, avoidId) {
  if (!Array.isArray(bits) || bits.length === 0) return null;
  let pool = bits;
  if (bits.length > 1 && avoidId) {
    const filtered = bits.filter((b) => b.id !== avoidId);
    if (filtered.length) pool = filtered;
  }
  const total = pool.reduce((s, b) => s + Math.max(1, b.weight || 1), 0);
  let r = Math.random() * total;
  for (const b of pool) {
    r -= Math.max(1, b.weight || 1);
    if (r <= 0) return b;
  }
  return pool[pool.length - 1];
}

const isSponsorBit = (b) => !!b && (b.sponsored === true || b.kind === "sponsor");

// Pick the next bit to show, enforcing a 1-in-5 sponsor cadence: every 5th bit
// shown is a sponsor (when one is available); the other four are non-sponsor.
// `nextIndex` is the 0-based position of the bit about to be shown. Degrades
// gracefully when only one category exists.
function pickNext(bits, avoidId, nextIndex) {
  if (!Array.isArray(bits) || bits.length === 0) return null;
  const sponsors = bits.filter(isSponsorBit);
  const others = bits.filter((b) => !isSponsorBit(b));
  const wantSponsor = sponsors.length > 0 && nextIndex % 5 === 4;
  if (wantSponsor) {
    return pickWeighted(sponsors, avoidId) || pickWeighted(bits, avoidId);
  }
  if (others.length) return pickWeighted(others, avoidId);
  return pickWeighted(bits, avoidId); // sponsors-only feed
}

// ── Rendering ───────────────────────────────────────────────────────────────
function osc8(url, text) {
  return `]8;;${url}\\${text}]8;;\\`;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return s.slice(0, max - 1).trimEnd() + "…";
}

function buildPrefix(session) {
  const segs = [];
  const branch = gitBranch(session);
  if (branch) segs.push(branch);
  const pct = ctxPct(session);
  if (pct != null) segs.push(`${pct}%`);
  if (segs.length === 0) {
    const m = modelName(session);
    if (m) segs.push(m);
  }
  return segs.join(" · "); // " · "
}

// ── Hot path ────────────────────────────────────────────────────────────────
function hotPath() {
  const session = readStdinJson();
  const installId = getInstallId();
  const cache = readJson(CACHE_FILE) || {};
  const settings = { ...DEFAULT_SETTINGS, ...(cache.settings || {}) };
  const bits = Array.isArray(cache.bits) ? cache.bits : [];

  const state = readJson(STATE_FILE) || freshState();
  if (!Array.isArray(state.queue)) state.queue = [];

  // Stash the Claude Code version so the detached --sync can report it.
  if (session?.version) state.cc_version = session.version;

  const now = Date.now();
  const prefix = buildPrefix(session);

  // Resolve the current bit. If it vanished from a refreshed feed, finalize the
  // selection (so its accrued time isn't lost) before picking a replacement.
  let current = bits.find((b) => b.id === state.current_bit_id) || null;
  if (!current && state.current_bit_id) {
    finalizeSelection(state, settings, now);
    state.last_bit_id = state.current_bit_id;
    state.current_bit_id = null;
    state.bit_started_at = null;
    state.bit_total_ms = 0;
    state.seg_accrued_ms = 0;
  }
  if (!current) {
    current = pickNext(bits, state.last_bit_id, state.shown_count || 0);
    if (current) startSelection(state, current, now);
  }

  // Rotation is decoupled from impression attestation:
  //  • impressions still need *continuous* on-screen time (gaps ≤ LIVE_GAP_MS)
  //    so they stay honest;
  //  • rotation is WALL-CLOCK: the line changes ~every max_dwell_ms since the
  //    bit first appeared, so it visibly cycles while Claude Code is
  //    re-rendering during a task — regardless of how bursty the renders are.

  // Track agent activity to drive the 15-min idle pause. The agent "did work"
  // when its usage fingerprint changes; we stamp last_active_at then. If the
  // session exposes no usable signal at all, we can't detect idle, so we keep
  // counting (don't pause).
  const fp = activityFingerprint(session);
  const agentActed = fp != null && fp !== state.last_fp;
  if (agentActed || state.last_active_at == null) state.last_active_at = now;
  const noSignal = fp == null && state.last_fp == null;
  const agentLive =
    noSignal || now - state.last_active_at <= AGENT_IDLE_MS;

  if (current) {
    const elapsed = state.last_tick_at ? now - state.last_tick_at : Infinity;
    // "continuous" = the session is live and ticking (event re-renders or the
    // refreshInterval heartbeat). LIVE_GAP_MS sits above refreshInterval so
    // normal idle heartbeats chain together; only a real discontinuity (the
    // session was closed, or the machine slept) exceeds it and is dropped, so
    // we never credit a giant unattended span in one go.
    const continuous = elapsed >= 0 && elapsed <= LIVE_GAP_MS;

    if (state.bit_started_at == null) {
      // First time we're showing this selection (e.g. migrated/old state).
      startSelection(state, current, now);
    } else {
      // Credit continuous on-screen time while the session is "live" — i.e. the
      // agent has done work within the last AGENT_IDLE_MS. Reading the agent's
      // output still counts (we don't require active work each tick); only a
      // 15-min stretch with no agent activity pauses it, until the agent runs
      // again. Idle pause does NOT stop the visual rotation below.
      if (continuous && agentLive) {
        state.bit_total_ms += elapsed;
        state.seg_accrued_ms += elapsed;
      } else if (!continuous) {
        state.seg_accrued_ms = 0; // session resumed after a gap; can't span it
      }
      // Rotate purely on wall-clock time since this bit became current.
      if (now - (state.bit_started_at || now) >= settings.max_dwell_ms) {
        finalizeSelection(state, settings, now);
        state.last_bit_id = current.id;
        current = pickNext(bits, current.id, state.shown_count || 0) || current;
        startSelection(state, current, now);
      }
    }
  }

  state.last_tick_at = now;
  state.last_fp = fp;
  writeJsonAtomic(STATE_FILE, state);

  // Compose the line.
  let line;
  if (current) {
    const head = prefix ? `${prefix} · ` : "";
    const sponsored = !!current.sponsored || current.kind === "sponsor";
    const url = `${BASE}/c/${current.id}?i=${installId}`;
    const marker = `${lavender(MARKER)} `; // ✱ bullet (lavender), before the bit
    // Trailing link affordance: sponsor bits get an orange CTA AFTER the text
    // (a custom per-bit label when set, else "Learn More"); regular bits get a
    // green ⬈ tucked onto the end of the underlined link. Both sit at the end
    // and signal "this is clickable".
    const cta = current.cta ? `${current.cta} ⬈` : "Learn More ⬈";
    const trailingCols = sponsored ? cta.length + 2 : 2; // +separator/space
    const used = head.length + 2 + trailingCols; // marker(✱)+space + trailing
    const budget = Math.max(MIN_BIT_COLS, MAX_COLS - used);
    const text = truncate(String(current.text || ""), budget);
    if (sponsored) {
      const body = osc8(url, underline(text));
      line = `${head}${marker}${body}  ${osc8(url, orange(cta))}`;
    } else {
      const body = osc8(url, underline(`${text} ⬈`));
      line = `${head}${marker}${body}`;
    }
  } else {
    // No bits yet (fresh install before first sync). Show the useful prefix so
    // we never blank a line the user was relying on.
    line = prefix;
  }
  if (line) process.stdout.write(line + "\n");

  // Decide whether to kick off a background sync (never awaited).
  const fetchedAt = Number(cache.fetched_at || 0);
  const stale =
    !cache.fetched_at || now - fetchedAt > settings.refresh_min * 60_000;
  if (stale || state.queue.length >= settings.flush_threshold) {
    spawnSync();
  }
}

function enqueue(state, ev) {
  state.queue.push(ev);
  if (state.queue.length > MAX_QUEUE) {
    state.queue.splice(0, state.queue.length - MAX_QUEUE); // drop oldest
  }
}

function spawnSync() {
  try {
    const child = spawn(process.execPath, [__filename, "--sync"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    /* if we can't spawn, we just sync on a later tick */
  }
}

// ── Background sync ─────────────────────────────────────────────────────────
async function sync() {
  const installId = getInstallId();

  // 1. Refresh the feed cache (scoped to the install's selected topics).
  try {
    let topicsParam = "";
    try {
      const t = fs.readFileSync(TOPICS_FILE, "utf8").trim();
      if (t) topicsParam = `&topics=${encodeURIComponent(t)}`;
    } catch {
      /* no topics file → all topics */
    }
    const res = await fetch(
      `${BASE}/api/feed?i=${encodeURIComponent(installId)}&v=${CLIENT_VERSION}${topicsParam}`,
      { headers: { "user-agent": `diff-bits/${CLIENT_VERSION}` } },
    );
    if (res.ok) {
      const feed = await res.json();
      if (feed && Array.isArray(feed.bits)) {
        feed.fetched_at = Date.now();
        writeJsonAtomic(CACHE_FILE, feed);
      }
    }
  } catch {
    /* offline — keep the old cache, try again next sync */
  }

  // 2. Flush queued events. Snapshot N, POST, then remove the first N on
  //    success. The hot path only ever appends to the tail, so the first N are
  //    exactly what we sent; concurrently-appended events survive.
  try {
    const state = readJson(STATE_FILE) || freshState();
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const n = queue.length;
    const impressions = [];
    const clicks = [];
    for (const ev of queue.slice(0, n)) {
      if (ev.type === "click") {
        clicks.push({ bit_id: ev.bit_id, clicked_at: ev.ts });
      } else {
        impressions.push({
          bit_id: ev.bit_id,
          shown_at: ev.ts,
          dwell_ms: ev.dwell_ms,
        });
      }
    }

    const body = {
      install_id: installId,
      impressions,
      clicks,
      heartbeat: {
        os: process.platform,
        arch: process.arch,
        cc_version: state.cc_version || null,
        client_version: CLIENT_VERSION,
        surface: "cli",
      },
    };

    const res = await fetch(`${BASE}/api/track`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `diff-bits/${CLIENT_VERSION}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok && n > 0) {
      // Re-read fresh state (hot path may have appended) and drop the first N.
      const fresh = readJson(STATE_FILE) || state;
      if (!Array.isArray(fresh.queue)) fresh.queue = [];
      fresh.queue.splice(0, n);
      writeJsonAtomic(STATE_FILE, fresh);
    }
  } catch {
    /* keep the queue; retry next sync */
  }
}

// ── Topics subcommand ────────────────────────────────────────────────────────
// Change your interests after install, without reinstalling:
//   node bits.mjs --topics            show current selection + options
//   node bits.mjs --topics ai,tech    set selection (validated)
//   node bits.mjs --topics all        clear selection (= every topic)
const TOPIC_SLUGS = [
  "ai", "tech", "business", "startups",
  "science", "finance", "politics", "world", "producthunt",
];

function topicsCmd(arg) {
  let current = "";
  try {
    current = fs.readFileSync(TOPICS_FILE, "utf8").trim();
  } catch {
    /* no file yet => all */
  }

  if (arg == null) {
    process.stdout.write(`Current topics: ${current || "all"}\n`);
    process.stdout.write(`Available: ${TOPIC_SLUGS.join(", ")}\n`);
    process.stdout.write(
      `Change with: node ~/.the-diff/bits/bits.mjs --topics ai,tech   (or "all")\n`,
    );
    return;
  }

  const raw = String(arg).trim().toLowerCase();
  const requested = raw.split(/[\s,]+/).filter(Boolean);
  let topics;
  if (!raw || raw === "all" || raw === "none") {
    topics = [];
  } else {
    topics = [...new Set(requested)].filter((t) => TOPIC_SLUGS.includes(t));
    const unknown = requested.filter((t) => !TOPIC_SLUGS.includes(t));
    if (unknown.length)
      process.stdout.write(`Ignored unknown topic(s): ${unknown.join(", ")}\n`);
  }

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TOPICS_FILE, topics.join(","));
  } catch {
    process.stdout.write("Could not save topics.\n");
    return;
  }
  process.stdout.write(
    `Topics set to: ${topics.length ? topics.join(", ") : "all"}\n`,
  );
  // Refresh the feed immediately so the new topics take effect right away.
  spawnSync();
}

// ── Entry ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (process.argv.includes("--version")) {
      process.stdout.write(CLIENT_VERSION + "\n");
    } else if (process.argv.includes("--topics")) {
      const i = process.argv.indexOf("--topics");
      topicsCmd(process.argv[i + 1]);
    } else if (process.argv.includes("--sync")) {
      await sync();
    } else {
      hotPath();
    }
  } catch {
    // Absolute fail-safe: never break Claude Code. Emit nothing, exit clean.
  }
  process.exit(0);
})();
