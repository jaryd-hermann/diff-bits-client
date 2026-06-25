import * as vscode from "vscode";
import { randomUUID } from "crypto";

// ===========================================================================
// The Diff Bits — Cursor / VS Code extension.
//
// A CLEAN rich-content surface: our own status-bar item + our own sidebar
// webview. We never touch Anthropic's extension bundle. Bits rotate from the
// same feed the terminal client uses, and impressions/clicks land in the same
// Supabase backend via /api/track and /c/[bitId]. Surface = "vscode".
// ===========================================================================

const CLIENT_VERSION = "0.2.0";

interface Bit {
  id: string;
  text: string;
  url: string | null;
  weight: number;
  kind?: string;
  image_url?: string | null;
  sponsored?: boolean;
}

function isSponsored(bit?: Bit): boolean {
  return !!bit && (bit.sponsored === true || bit.kind === "sponsor");
}
interface Settings {
  dwell_ms: number;
  max_dwell_ms: number;
  refresh_min: number;
  flush_threshold: number;
}
const DEFAULT_SETTINGS: Settings = {
  dwell_ms: 4000,
  max_dwell_ms: 9000,
  refresh_min: 30,
  flush_threshold: 20,
};

// Presence gating. A bit only accrues on-screen time while the editor window is
// focused AND the user is plausibly present — interacted within IDLE_LIMIT_MS,
// OR has a terminal open (the agent is likely working there). This stops the
// phantom-impression bug (a backgrounded or slept editor logging a rotation
// forever) while staying generous for the agent-in-terminal workflow. Focus +
// the OS suspending timers on sleep are the backstops against an abandoned
// but awake editor.
const TICK_MS = 1000;
const IDLE_LIMIT_MS = 120_000;

function baseUrl(): string {
  const u = vscode.workspace
    .getConfiguration("diffBits")
    .get<string>("baseUrl", "https://bits.the-diff.com");
  return u.replace(/\/$/, "");
}

export function activate(context: vscode.ExtensionContext) {
  const controller = new FeedController(context);

  // Status bar item (rotating bit, clickable).
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  status.command = "diffBits.openCurrent";
  context.subscriptions.push(status);

  // Sidebar rich-ad webview.
  const view = new BitsViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("diffBits.feed", view),
  );

  const render = () => {
    const bit = controller.current();
    const showStatus = vscode.workspace
      .getConfiguration("diffBits")
      .get<boolean>("showStatusBar", true);
    if (bit && showStatus) {
      const sp = isSponsored(bit) ? "$(megaphone) Sponsored: " : "$(diff-added) ";
      status.text = `${sp}${truncate(bit.text, 56)}`;
      status.tooltip = `${isSponsored(bit) ? "Sponsored\n" : ""}${bit.text}${bit.url ? "\nClick to read →" : ""}`;
      status.show();
    } else {
      status.hide();
    }
    view.update(bit);
  };
  controller.onChange(render);

  context.subscriptions.push(
    vscode.commands.registerCommand("diffBits.openCurrent", () =>
      controller.openCurrent(),
    ),
    vscode.commands.registerCommand("diffBits.next", () => controller.next()),
    vscode.commands.registerCommand("diffBits.show", () =>
      vscode.commands.executeCommand("diffBits.feed.focus"),
    ),
  );
  // The webview asks us to open when its CTA is clicked.
  view.onOpen(() => controller.openCurrent());

  context.subscriptions.push({ dispose: () => controller.dispose() });
  controller.start();
}

export function deactivate() {}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

// ── Feed controller ─────────────────────────────────────────────────────────
class FeedController {
  private bits: Bit[] = [];
  private settings: Settings = DEFAULT_SETTINGS;
  private index = 0;
  private rotations = 0; // total rotations — drives the 1-in-5 sponsor cadence
  private lastId: string | null = null;
  private installId: string;
  private queue: { bit_id: string; shown_at: string; dwell_ms: number }[] = [];
  private tickTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private listeners: (() => void)[] = [];
  private disposables: vscode.Disposable[] = [];

  // Presence + dwell tracking for the current selection.
  private started = false;
  private liveMs = 0; // continuous live (focused + active) on-screen time accrued
  private shownAtIso = ""; // ISO timestamp of when this selection became current
  private focused = true;
  private lastActivityAt = 0;

  constructor(private context: vscode.ExtensionContext) {
    let id = context.globalState.get<string>("diffBits.installId");
    if (!id) {
      id = randomUUID();
      context.globalState.update("diffBits.installId", id);
    }
    this.installId = id;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  current(): Bit | undefined {
    return this.bits[this.index];
  }

  async start() {
    await this.register();
    this.installActivityWatchers();
    await this.refresh();
    this.flushTimer = setInterval(() => this.flush(), 30_000);
    this.refreshTimer = setInterval(
      () => this.refresh(),
      this.settings.refresh_min * 60_000,
    );
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  // Track window focus + user activity so we only credit time the user is
  // plausibly present. Disposed with the controller.
  private bump = () => {
    this.lastActivityAt = Date.now();
  };
  private installActivityWatchers() {
    this.focused = vscode.window.state.focused;
    this.bump();
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        this.focused = s.focused;
        if (s.focused) this.bump();
      }),
      vscode.window.onDidChangeTextEditorSelection(this.bump),
      vscode.window.onDidChangeActiveTextEditor(this.bump),
      vscode.workspace.onDidChangeTextDocument(this.bump),
      vscode.window.onDidChangeActiveTerminal(this.bump),
      vscode.window.onDidOpenTerminal(this.bump),
      vscode.window.onDidCloseTerminal(this.bump),
    );
  }

  private isLive(now: number): boolean {
    if (!this.focused) return false;
    return (
      now - this.lastActivityAt <= IDLE_LIMIT_MS ||
      vscode.window.terminals.length > 0
    );
  }

  // Heartbeat: accrue live on-screen time for the current bit, and rotate after
  // max_dwell of *viewed* time. While away (unfocused or idle) we freeze — no
  // accrual, no rotation — so nothing is counted that the user didn't see.
  private tick() {
    const now = Date.now();
    if (!this.started || !this.current()) return;
    if (!this.isLive(now)) return;
    this.liveMs += TICK_MS;
    if (this.liveMs >= this.settings.max_dwell_ms) this.next();
  }

  // Begin showing the bit at the current index with a fresh clock.
  private startSelection() {
    this.lastId = this.current()?.id ?? this.lastId;
    this.liveMs = 0;
    this.shownAtIso = new Date().toISOString();
    this.emit();
  }

  // Emit exactly ONE impression for the selection that's ending, carrying its
  // TOTAL live on-screen time — only if it was actually viewed past the dwell
  // threshold. Idle/unfocused time never accrued, so an untended editor counts
  // for nothing.
  private finalizeSelection() {
    const bit = this.current();
    if (bit && this.liveMs >= this.settings.dwell_ms) {
      this.queue.push({
        bit_id: bit.id,
        shown_at: this.shownAtIso,
        dwell_ms: Math.round(this.liveMs),
      });
      if (this.queue.length >= this.settings.flush_threshold) this.flush();
    }
  }

  next() {
    this.finalizeSelection();
    this.advance();
    this.startSelection();
  }

  // Advance the index, enforcing a 1-in-5 sponsor cadence: every 5th rotation
  // lands on a sponsor (when one exists); the other four prefer non-sponsors.
  // Falls back gracefully when only one category is present.
  private advance() {
    const n = this.bits.length;
    if (n <= 1) return;
    this.rotations++;
    const wantSponsor =
      this.bits.some(isSponsored) && this.rotations % 5 === 0;
    const matches = (b: Bit) =>
      wantSponsor ? isSponsored(b) : !isSponsored(b);
    const scan = (pred: (b: Bit) => boolean): number => {
      for (let k = 1; k <= n; k++) {
        const i = (this.index + k) % n;
        if (pred(this.bits[i])) return i;
      }
      return -1;
    };
    let i = scan((b) => matches(b) && b.id !== this.lastId);
    if (i === -1) i = scan((b) => b.id !== this.lastId); // any non-repeat
    if (i === -1) i = (this.index + 1) % n; // last resort
    this.index = i;
  }

  openCurrent() {
    const bit = this.current();
    if (!bit) return;
    // /c records the click server-side, then 302s to the destination.
    const url = `${baseUrl()}/c/${bit.id}?i=${encodeURIComponent(this.installId)}`;
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async register() {
    try {
      await fetch(`${baseUrl()}/api/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          install_id: this.installId,
          os: process.platform,
          arch: process.arch,
          client_version: CLIENT_VERSION,
          surface: "vscode",
        }),
      });
    } catch {
      /* offline — will register implicitly via heartbeat on next flush */
    }
  }

  private async refresh() {
    try {
      const res = await fetch(
        `${baseUrl()}/api/feed?i=${encodeURIComponent(this.installId)}&v=${CLIENT_VERSION}`,
      );
      if (!res.ok) return;
      const feed = (await res.json()) as { bits?: Bit[]; settings?: Settings };
      if (Array.isArray(feed.bits)) {
        const prevId = this.current()?.id ?? null;
        this.bits = feed.bits;
        this.settings = { ...DEFAULT_SETTINGS, ...(feed.settings ?? {}) };
        if (this.index >= this.bits.length) this.index = 0;
        if (!this.started && this.bits.length) {
          this.started = true;
          this.startSelection();
        } else if (this.current()?.id !== prevId) {
          // The bit we were showing changed identity under us — finalize the
          // old selection (crediting its viewed time) before starting fresh.
          this.finalizeSelection();
          this.startSelection();
        } else {
          this.emit();
        }
      }
    } catch {
      /* keep current bits */
    }
  }

  private async flush() {
    if (!this.queue.length) {
      // still send a heartbeat occasionally so last_seen + surface stay fresh
      return;
    }
    const sending = this.queue.splice(0, this.queue.length);
    try {
      const res = await fetch(`${baseUrl()}/api/track`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          install_id: this.installId,
          impressions: sending,
          heartbeat: {
            os: process.platform,
            arch: process.arch,
            client_version: CLIENT_VERSION,
            surface: "vscode",
          },
        }),
      });
      if (!res.ok) this.queue.unshift(...sending); // retry next flush
    } catch {
      this.queue.unshift(...sending);
    }
  }

  dispose() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const d of this.disposables) d.dispose();
    this.finalizeSelection();
    void this.flush();
  }
}

// ── Sidebar rich-ad webview ─────────────────────────────────────────────────
class BitsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: Bit;
  private openHandlers: (() => void)[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  onOpen(fn: () => void) {
    this.openHandlers.push(fn);
  }

  update(bit: Bit | undefined) {
    this.pending = bit;
    this.view?.webview.postMessage({
      type: "bit",
      text: bit?.text ?? "",
      hasUrl: !!bit?.url,
      image: bit?.image_url || null,
      sponsored: isSponsored(bit),
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    const logoUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "diff-logo.png"),
    );
    view.webview.html = this.html(view.webview, logoUri);
    view.webview.onDidReceiveMessage((m) => {
      if (m?.type === "open") for (const fn of this.openHandlers) fn();
    });
    if (this.pending) this.update(this.pending);
  }

  private html(webview: vscode.Webview, logo: vscode.Uri): string {
    const nonce = randomUUID().replace(/-/g, "");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { --green: #34c173; --ink: #181810; }
  body { font-family: var(--vscode-font-family); padding: 14px; color: var(--vscode-foreground); }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; background: var(--vscode-editorWidget-background); }
  .row { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  .logo { width: 22px; height: 22px; border-radius: 5px; }
  .label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; opacity:.6; }
  .dot { color: var(--green); }
  .headline { font-size: 14px; line-height: 1.4; margin: 4px 0 14px; }
  .cta { display:inline-block; width:100%; box-sizing:border-box; text-align:center; border:none; border-radius:6px; padding:8px 12px; font-weight:600; cursor:pointer; background: var(--green); color: #0b0b08; }
  .cta:hover { opacity:.9; }
  .empty { opacity:.6; font-size: 12px; }
  .pill { margin-left:auto; font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:#0b0b08; background:#e8a13c; border-radius:4px; padding:2px 6px; font-weight:700; }
</style>
</head>
<body>
  <div class="card">
    <div class="row">
      <img id="logo" class="logo" src="${logo}" data-default="${logo}" alt="" />
      <span class="label"><span class="dot">●</span> The Diff Bits</span>
      <span id="sponsored" class="pill" style="display:none">Sponsored</span>
    </div>
    <div id="headline" class="headline empty">Loading bits…</div>
    <button id="cta" class="cta" style="display:none">Read →</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const headline = document.getElementById('headline');
  const cta = document.getElementById('cta');
  const logo = document.getElementById('logo');
  const sponsored = document.getElementById('sponsored');
  const defaultLogo = logo.getAttribute('data-default');
  cta.addEventListener('click', () => vscode.postMessage({ type: 'open' }));
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'bit') {
      if (m.text) { headline.textContent = m.text; headline.classList.remove('empty'); }
      else { headline.textContent = 'Loading bits…'; headline.classList.add('empty'); }
      cta.style.display = m.hasUrl ? 'inline-block' : 'none';
      logo.src = m.image || defaultLogo;
      sponsored.style.display = m.sponsored ? 'inline-block' : 'none';
    }
  });
</script>
</body>
</html>`;
  }
}
