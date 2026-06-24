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

const CLIENT_VERSION = "0.1.0";

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
  private lastId: string | null = null;
  private installId: string;
  private displaySeq = 0;
  private queue: { bit_id: string; shown_at: string; dwell_ms: number }[] = [];
  private rotateTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private listeners: (() => void)[] = [];

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
    await this.refresh();
    this.flushTimer = setInterval(() => this.flush(), 30_000);
    this.refreshTimer = setInterval(
      () => this.refresh(),
      this.settings.refresh_min * 60_000,
    );
    this.scheduleRotate();
  }

  private scheduleRotate() {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(
      () => this.next(),
      this.settings.max_dwell_ms,
    );
  }

  next() {
    if (this.bits.length > 1) {
      let i = this.index;
      // advance, avoiding an immediate repeat
      for (let n = 0; n < 5; n++) {
        i = (i + 1) % this.bits.length;
        if (this.bits[i].id !== this.lastId) break;
      }
      this.index = i;
    }
    this.show();
  }

  /** Show the current bit: notify UI + schedule an impression past dwell. */
  private show() {
    const bit = this.current();
    if (!bit) return;
    this.lastId = bit.id;
    const seq = ++this.displaySeq;
    const shownAt = new Date().toISOString();
    this.emit();
    // Count one impression if it stays shown past the dwell threshold.
    setTimeout(() => {
      if (seq === this.displaySeq) {
        this.queue.push({
          bit_id: bit.id,
          shown_at: shownAt,
          dwell_ms: this.settings.dwell_ms,
        });
        if (this.queue.length >= this.settings.flush_threshold) this.flush();
      }
    }, this.settings.dwell_ms);
    this.scheduleRotate();
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
        this.bits = feed.bits;
        this.settings = { ...DEFAULT_SETTINGS, ...(feed.settings ?? {}) };
        if (this.index >= this.bits.length) this.index = 0;
        if (this.displaySeq === 0) this.show();
        else this.emit();
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
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
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
