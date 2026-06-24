# The Diff Bits — open-source client

This repository contains **everything that runs on your machine** when you
install [The Diff Bits](https://bits.the-diff.com): the installer, the
Claude Code status-line client, and the optional Cursor / VS Code extension.

It's published so you can **read exactly what you're running before you install
it.** The files here are the same ones served from `bits.the-diff.com`.

## What it does

The Diff Bits shows bite-size tech & world news, ideas, and TLDRs in your
**Claude Code status line** (and an editor panel) during the wait states while
the agent works. You pick your topics; you can uninstall anytime.

Install:

```sh
curl -fsSL https://bits.the-diff.com/install.sh | sh
```

## What's in here

| File | What it is |
| --- | --- |
| [`bits.mjs`](bits.mjs) | The status-line client. Runs as Claude Code's `statusLine` command. Zero dependencies (Node ≥18 built-ins only). |
| [`install.sh`](install.sh) | The one-line installer. Backs up + safely merges your `~/.claude/settings.json`, and installs the editor extension if Cursor/VS Code is found. |
| [`uninstall.sh`](uninstall.sh) | One-command clean uninstall — restores your previous status line, removes everything. |
| [`test.mjs`](test.mjs) | The client's test suite (rendering, rotation, fail-safe, sync). Run with `node test.mjs`. |
| [`extension/`](extension/) | The Cursor / VS Code extension source. |

## Privacy & safety — what it does and doesn't do

**It reads:** the session JSON Claude Code pipes to the status-line command (to
show your git branch), your repo's `.git/HEAD`, and a local cache of bits under
`~/.the-diff/bits/`.

**It never reads:** your code, your prompts, the AI's responses, file contents,
file paths, or repository names. The telemetry literally has no field that could
carry them.

**It makes exactly two network calls**, both off the hot path in a detached
background process:
- `GET /api/feed` — download the rotating content (bits + settings).
- `POST /api/track` — anonymous impression/click counts + a heartbeat
  (OS, client version). Keyed only by a random per-install UUID.

**It is fail-safe:** any error degrades to a normal/blank status line and exits
clean. It can never break Claude Code.

No remote-code-execution, no reading of credentials or source, no IP stored.
Verify all of the above by reading `bits.mjs` — it's ~600 lines and commented.

## License

MIT — see [LICENSE](LICENSE).
