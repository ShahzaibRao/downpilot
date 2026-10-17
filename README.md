# DownPilot

**Creator-first download manager** — two modes, one shared engine.

- **Quick mode** — paste a link → choose scope (single video / playlist / channel) and quality → download.
- **Prospect mode** — track creators, auto-watch for new content, auto-download.

Built on a DownVid-grade engine: yt-dlp + gallery-dl behind an engine router with fallback, chunked multi-part downloads with resume, a Go sidecar that manages all runtime dependencies, Smart Mode (proxy for extraction, direct for download), per-platform cookie profiles, and a Deno POT server for YouTube.

## Status

**Phase 0 — Foundation** (in progress): Electron shell + Go sidecar wiring. The Settings tab
shows live dependency status from `dp-deps` and can download missing tools.

## Development

Requirements: **Node.js 20+** and **Go 1.24+**.

```powershell
# 1. clone
git clone https://github.com/ShahzaibRao/downpilot.git
cd downpilot

# 2. build the sidecar (produces backend/bin/dp-deps.exe on Windows)
npm run sidecar:build:win   # or: npm run sidecar:build   (Linux/macOS)

# 3. install JS deps and run the app in dev mode
npm install
npm run dev
```

Open **Settings** in the app: it detects the 5 runtime deps (yt-dlp, ffmpeg, ffprobe,
gallery-dl, deno) and offers one-click download for missing ones — all through the
Go sidecar, with SHA-256 verification.

Other scripts: `npm run build` (production bundle), `npm run typecheck`,
`npm run manifest` (regenerate the pinned dependency manifest).

## Architecture

- `electron/` — main process: download core, engine router, queue, prospect scheduler, cookie vault, Deno manager, sidecar client
- `src/` — renderer (Vue 3 + TypeScript): Quick / Prospect / History / Settings views
- `backend/` — Go dependency sidecar (`dp-deps`): detects/installs yt-dlp, ffmpeg, ffprobe, gallery-dl, deno (pinned + SHA-256 verified)
- `shared/` — code shared between main and renderer
- `scripts/` — build, manifest generation, release helpers
- `tests/` — unit + integration tests
- `docs/` — design docs

Full HLD/LLD live in the project's Notion design notes.

## Design principles

- **Offline-first desktop** — no account needed for local use (Phase 1).
- **One shared engine, two UIs** — Quick and Prospect modes consume the same download core.
- **Relay-only cloud (Phase 2)** — execution always stays on the user's PC; the cloud only relays commands and mirrors state.
- **No secrets in code** — cookie values and tokens live in the OS keychain, never in files.
- **Every release is a patch bump** — `0.1.0 → 0.1.1` for any user-facing fix (required for auto-update to detect it).

## License & credits

MIT — see [LICENSE](LICENSE).

DownPilot's engine design learns from [DownVid](https://github.com/yxxbc/downvid) (MIT, © yxxbc), itself evolved from [Videdown](https://github.com/cshuangyy/videdown) (MIT, © cshuangyy). Thanks to the maintainers of yt-dlp, gallery-dl, and FFmpeg.
