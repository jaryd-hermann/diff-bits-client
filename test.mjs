#!/usr/bin/env node
// ===========================================================================
// Test harness for bits.mjs. No external deps, no network beyond a local mock.
// Runs the real client as a subprocess against throwaway temp dirs and a local
// HTTP mock, manipulating state.json to simulate the passage of dwell time.
//
//   node client/test.mjs
//
// Exits non-zero if any assertion fails.
// ===========================================================================

import { spawnSync, spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "bits.mjs");

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bits-test-"));
}

// Run the hot path once. Returns { stdout, state, dir }.
function runHot(dir, { stdin = "{}", base = "http://127.0.0.1:9", env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLIENT], {
    input: stdin,
    env: {
      ...process.env,
      DIFF_BITS_DIR: dir,
      DIFF_BITS_BASE_URL: base,
      NO_COLOR: "1",
      ...env,
    },
    encoding: "utf8",
    timeout: 8000,
  });
  const state = readJson(path.join(dir, "state.json"));
  return { stdout: r.stdout || "", status: r.status, state };
}

// Async spawn so the in-process mock HTTP server can respond while --sync runs
// (spawnSync would block this process's event loop and deadlock the server).
function runAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, NO_COLOR: "1", ...env },
      encoding: "utf8",
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(f, o) {
  fs.writeFileSync(f, JSON.stringify(o));
}

// Simulate `ms` of elapsed time: the next hot run sees `ms` since the last tick
// (for impression accrual), and the current bit is aged by `ms` (cumulatively)
// so wall-clock rotation can trigger.
function rewind(dir, ms) {
  const f = path.join(dir, "state.json");
  const s = readJson(f);
  s.last_tick_at = Date.now() - ms;
  if (s.bit_started_at != null) s.bit_started_at -= ms;
  writeJson(f, s);
}

function writeCache(dir, bits, settings = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "install_id"), "11111111-1111-1111-1111-111111111111");
  writeJson(path.join(dir, "cache.json"), {
    fetched_at: Date.now(),
    settings: { dwell_ms: 4000, max_dwell_ms: 9000, refresh_min: 30, flush_threshold: 20, ...settings },
    bits,
  });
}

const BITS = [
  { id: "aaaaaaaa-0000-0000-0000-000000000001", text: "First punchy bit about retention loops.", url: "https://x/1", weight: 1 },
  { id: "bbbbbbbb-0000-0000-0000-000000000002", text: "Second bit about pricing as a feature.", url: "https://x/2", weight: 1 },
];

// ── Tests ───────────────────────────────────────────────────────────────────
console.log("\n[1] renders a bit with OSC 8 link + marker");
{
  const dir = tmpDir();
  writeCache(dir, BITS);
  const { stdout, status } = runHot(dir, { stdin: JSON.stringify({ version: "1.2.3" }) });
  ok("exit 0", status === 0, `status=${status}`);
  ok("contains marker ❑", stdout.includes("❑"));
  ok("contains OSC 8 click url with install id", /\]8;;http.*\/c\/[a-f0-9-]+\?i=11111111-/.test(stdout));
  ok("only one line", stdout.split("\n").filter(Boolean).length === 1);
}

console.log("\n[2] shows git branch from .git/HEAD as the prefix");
{
  const dir = tmpDir();
  writeCache(dir, BITS);
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feature-x\n");
  const { stdout } = runHot(dir, { stdin: JSON.stringify({ cwd: repo }) });
  ok("prefix contains branch", stdout.includes("feature-x"), stdout.trim());
}

console.log("\n[3] impression carries cumulative dwell, emitted once on rotation");
{
  const dir = tmpDir();
  writeCache(dir, BITS, { dwell_ms: 1000, max_dwell_ms: 3000 });
  runHot(dir); // tick 1: establish current bit, no count (first tick)
  let s = readJson(path.join(dir, "state.json"));
  ok("tick 1 enqueues nothing", (s.queue || []).length === 0);
  ok("tick 1 picked a current bit", !!s.current_bit_id);
  const first = s.current_bit_id;

  rewind(dir, 1500); // 1.5s continuous: past dwell, under max → keep showing
  runHot(dir);
  s = readJson(path.join(dir, "state.json"));
  ok("no impression before rotation", (s.queue || []).length === 0, JSON.stringify(s.queue));
  ok("accrues toward rotation on same bit", s.bit_total_ms >= 1500 && s.current_bit_id === first);

  rewind(dir, 2000); // total ~3.5s ≥ max_dwell → rotate + finalize
  runHot(dir);
  s = readJson(path.join(dir, "state.json"));
  ok("one impression emitted on rotation", (s.queue || []).length === 1, JSON.stringify(s.queue));
  ok(
    "impression carries cumulative dwell",
    s.queue[0]?.type === "impression" && s.queue[0]?.dwell_ms >= 3000,
    JSON.stringify(s.queue),
  );
  ok("rotated to a different bit", s.current_bit_id && s.current_bit_id !== first);

  rewind(dir, 500); // small tick on the freshly-selected bit
  runHot(dir);
  s = readJson(path.join(dir, "state.json"));
  ok("no double-count for the new selection", (s.queue || []).length === 1, JSON.stringify(s.queue));
}

console.log("\n[4] wall-clock rotation: changes after max_dwell regardless of bursts");
{
  // A — a bit under the wall-clock window stays; past it, it rotates and emits
  // exactly one impression for the time it was shown.
  const dir = tmpDir();
  writeCache(dir, BITS, { dwell_ms: 1000, max_dwell_ms: 9000 });
  runHot(dir);
  let s = readJson(path.join(dir, "state.json"));
  const first = s.current_bit_id;
  rewind(dir, 1500); runHot(dir); // 1.5s wall clock: < max → keep showing
  ok("A: under the window, same bit", readJson(path.join(dir, "state.json")).current_bit_id === first);
  rewind(dir, 8000); runHot(dir); // ~9.5s total ≥ max_dwell → rotate
  s = readJson(path.join(dir, "state.json"));
  ok("A: rotated after the wall-clock window", s.current_bit_id && s.current_bit_id !== first, `${first} -> ${s.current_bit_id}`);
  ok("A: recorded last_bit_id", s.last_bit_id === first);
  ok("A: emitted one impression with its dwell", (s.queue || []).length === 1 && s.queue[0]?.dwell_ms >= 1000, JSON.stringify(s.queue));

  // B — a bit that never earned its dwell still rotates off after the window,
  // but emits NO impression (honest: it wasn't shown long enough to count).
  const dir2 = tmpDir();
  writeCache(dir2, BITS, { dwell_ms: 4000, max_dwell_ms: 9000 });
  runHot(dir2);
  let s2 = readJson(path.join(dir2, "state.json"));
  const firstB = s2.current_bit_id;
  rewind(dir2, 1000); runHot(dir2); // 1s continuous, < dwell
  rewind(dir2, 60_000); runHot(dir2); // long gap → wall clock ≥ max → rotate, still under dwell
  s2 = readJson(path.join(dir2, "state.json"));
  ok("B: rotated after the window", s2.current_bit_id !== firstB, `${firstB} -> ${s2.current_bit_id}`);
  ok("B: no impression (never earned dwell)", (s2.queue || []).length === 0, JSON.stringify(s2.queue));
}

console.log("\n[5] a long idle gap never fabricates an impression");
{
  const dir = tmpDir();
  writeCache(dir, BITS, { dwell_ms: 4000 });
  runHot(dir);
  rewind(dir, 60_000); // 60s gap — user walked away before any continuous dwell
  runHot(dir);
  const s = readJson(path.join(dir, "state.json"));
  ok("no impression across idle gap", (s.queue || []).length === 0, JSON.stringify(s.queue));
  ok("no on-screen time fabricated", (s.bit_total_ms || 0) === 0 && (s.seg_accrued_ms || 0) === 0);
}

console.log("\n[6] fail-safe: malformed inputs never crash");
{
  // bad stdin
  let dir = tmpDir();
  writeCache(dir, BITS);
  let r = runHot(dir, { stdin: "this is not json{" });
  ok("bad stdin exits 0", r.status === 0);
  ok("bad stdin still renders", r.stdout.includes("❑"));

  // corrupt cache.json
  dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cache.json"), "}{ broken");
  fs.writeFileSync(path.join(dir, "install_id"), "22222222-2222-2222-2222-222222222222");
  r = runHot(dir, { stdin: JSON.stringify({ cwd: "/nope" }) });
  ok("corrupt cache exits 0", r.status === 0);

  // corrupt state.json
  dir = tmpDir();
  writeCache(dir, BITS);
  fs.writeFileSync(path.join(dir, "state.json"), "<<<corrupt>>>");
  r = runHot(dir, { stdin: "{}" });
  ok("corrupt state exits 0", r.status === 0);
  ok("corrupt state recovers and renders", r.stdout.includes("❑"));

  // empty stdin
  dir = tmpDir();
  writeCache(dir, BITS);
  r = runHot(dir, { stdin: "" });
  ok("empty stdin exits 0", r.status === 0);
}

console.log("\n[7] no bits yet (fresh install) → prints prefix, never blank-crashes");
{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "install_id"), "33333333-3333-3333-3333-333333333333");
  const repo = tmpDir();
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const r = runHot(dir, { stdin: JSON.stringify({ cwd: repo }), base: "http://127.0.0.1:9" });
  ok("exits 0 with no cache", r.status === 0);
  ok("prints the git prefix", r.stdout.includes("main"));
}

// ── Async sync test (mock server) ───────────────────────────────────────────
console.log("\n[8] --sync refreshes cache and flushes the queue");
const received = { tracks: [] };
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/feed")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      settings: { dwell_ms: 4000, max_dwell_ms: 9000, refresh_min: 30, flush_threshold: 20 },
      bits: [{ id: "cccccccc-0000-0000-0000-000000000003", text: "Server-served bit.", url: "https://x/3", weight: 1 }],
    }));
  } else if (req.url.startsWith("/api/track")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { received.tracks.push(JSON.parse(body)); } catch { received.tracks.push(null); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "install_id"), "44444444-4444-4444-4444-444444444444");
  // Pre-seed a queue with one impression + one click.
  writeJson(path.join(dir, "state.json"), {
    ...{ current_bit_id: null, last_bit_id: null, shown_at: null, accrued_ms: 0, counted: false, last_tick_at: Date.now(), cc_version: "9.9.9" },
    queue: [
      { type: "impression", bit_id: BITS[0].id, ts: new Date().toISOString(), dwell_ms: 4200 },
      { type: "click", bit_id: BITS[1].id, ts: new Date().toISOString() },
    ],
  });

  const r = await runAsync([CLIENT, "--sync"], { DIFF_BITS_DIR: dir, DIFF_BITS_BASE_URL: base });
  ok("sync exits 0", r.status === 0, `status=${r.status} ${r.stderr}`);

  const cache = readJson(path.join(dir, "cache.json"));
  ok("cache.json written from feed", !!cache && Array.isArray(cache.bits) && cache.bits.length === 1);
  ok("cache has fetched_at", !!cache?.fetched_at);

  ok("server received a track POST", received.tracks.length === 1);
  const t = received.tracks[0];
  ok("track has 1 impression + 1 click", t?.impressions?.length === 1 && t?.clicks?.length === 1, JSON.stringify(t));
  ok("track heartbeat carries cc_version", t?.heartbeat?.cc_version === "9.9.9");

  const s = readJson(path.join(dir, "state.json"));
  ok("queue drained after successful flush", (s.queue || []).length === 0, JSON.stringify(s.queue));
}

console.log("\n[9] --sync tolerates an offline server (queue preserved)");
{
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "install_id"), "55555555-5555-5555-5555-555555555555");
  writeJson(path.join(dir, "state.json"), {
    current_bit_id: null, last_bit_id: null, shown_at: null, accrued_ms: 0, counted: false, last_tick_at: Date.now(), cc_version: null,
    queue: [{ type: "impression", bit_id: BITS[0].id, ts: new Date().toISOString(), dwell_ms: 5000 }],
  });
  const r = await runAsync([CLIENT, "--sync"], { DIFF_BITS_DIR: dir, DIFF_BITS_BASE_URL: "http://127.0.0.1:9" });
  ok("offline sync exits 0", r.status === 0);
  const s = readJson(path.join(dir, "state.json"));
  ok("queue preserved when offline", (s.queue || []).length === 1, JSON.stringify(s.queue));
}

server.close();

console.log(`\n${"─".repeat(48)}`);
console.log(`${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
