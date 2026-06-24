# The Diff Bits — Cursor / VS Code extension

The rich-content surface for The Diff Bits, in the editor where most of the
audience actually works. This is the **clean** approach — our own status-bar
item and our own sidebar webview. We never patch Anthropic's (or anyone's)
extension bundle, so there's nothing to break on a Claude Code update and no
security policy to weaken.

## What it does

- **Status bar item** — a rotating bit in the bottom bar. Click it to open the
  piece (which records the click via `/c/[bitId]`).
- **Sidebar "Bits" view** — a rich ad unit (logo + headline + clickable CTA) in
  its own activity-bar panel. This is the surface that supports logo + link +
  styled layout that a terminal status line can't.
- **Tracking** — registers as an install with `surface: "vscode"`, and reports
  impressions/clicks into the same Supabase backend as the terminal client
  (`/api/install`, `/api/feed`, `/api/track`, `/c/[bitId]`). No backend changes.

## Run it in development

From this `extension/` folder:

```bash
npm install
npm run compile        # or: npm run watch
```

Then open the `extension/` folder in VS Code / Cursor and press **F5**
("Run Extension"). A second editor window (the Extension Development Host)
launches with Diff Bits active:

- look for the rotating bit in the **status bar** (bottom-right),
- and the **◆ Diff Bits icon in the activity bar** (left) for the rich panel.

To point at a local backend instead of production, set the setting
`diffBits.baseUrl` (e.g. `http://localhost:3000`) in the dev-host window.

## Package a `.vsix` (for sideloading / the marketplace)

```bash
npm install -g @vscode/vsce
npm run package          # produces diff-bits-0.1.0.vsix
```

Install the `.vsix` via the Extensions view → "··· → Install from VSIX…", or
`code --install-extension diff-bits-0.1.0.vsix`.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `diffBits.baseUrl` | `https://bits.the-diff.com` | Backend origin |
| `diffBits.showStatusBar` | `true` | Toggle the status-bar bit |

## Notes / roadmap

- v1 rotates bits on a timer (own real estate), independent of Claude's spinner
  — the clean, robust choice. Tying display to Claude's working state would mean
  observing its extension, which we deliberately avoid.
- The rich panel currently shows the Diff logo; per-bit sponsor logos/images are
  a feed-schema addition (`image_url`) when we build the Sponsors flow.
