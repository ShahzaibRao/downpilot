# DownPilot

**Creator-first download manager** — two modes, one shared engine.

- **Quick mode** — paste a link → choose scope (single video / playlist / channel) and quality → download.
- **Prospect mode** — track creators, auto-watch for new content, auto-download.

Built on a DownVid-grade engine: yt-dlp + gallery-dl behind an engine router with fallback, chunked multi-part downloads with resume, a Go sidecar that manages all runtime dependencies, Smart Mode (proxy for extraction, direct for download), per-platform cookie profiles, and a Deno POT server for YouTube.

## ✨ Features (v0.1.2)

**📊 Dashboard** — stats at a glance: downloads, storage, top speed, success rate, live speed graph, platform breakdown, top creators, 7-day chart, recent activity.

**⚡ Quick** — paste any link, platform auto-detected with colored badge. Single video, playlist, or channel scope. Bulk add with duplicate detection.

**📋 Queue** — dedicated tab with status filters (all/active/done/failed), pause/resume/retry, per-task progress + speed.

**👁️ Prospect** — auto-watch creators:
- Per-creator multi-platform links (TikTok, YouTube, Instagram, X, Snapchat) → one folder
- Auto-check every 15m–24h (configurable), new content auto-downloaded
- Seen-tracking by content ID — deleted files **never** re-download
- Search, status/platform filters, sort, collapsible cards, bulk actions
- Grid/list view, health ring, download counts, one-click folder open
- Per-link status with auto-pause on repeated failures + suggested fixes

**📜 History** — last 100 downloads with search, status filters, one-click re-download.

**🎨 Appearance** — light/dark/system theme + custom accent color picker.

**⚙️ Settings** — download folder, concurrency, Smart Mode proxies, POT server, cookie profiles, runtime dependencies, auto-updates.

**🔄 Auto-updates** — checks on startup + daily via GitHub Releases, downloads in background, prompts before restart.

## 📥 Download

Get the latest installer from [GitHub Releases](https://github.com/ShahzaibRao/downpilot/releases).

Windows x64. Unsigned build — SmartScreen may show "Windows protected your PC" → More info → Run anyway.

## 🛠️ Development

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

Other scripts: `npm run build` (production bundle), `npm run dist` (Windows installer),
`npm run typecheck`, `npm run manifest` (regenerate the pinned dependency manifest).

## 🏗️ Architecture

- `electron/` — main process: download core, engine router, queue, prospect scheduler, cookie vault, Deno manager, sidecar client, auto-updater, stats store
- `src/` — renderer (Vue 3 + TypeScript): Dashboard / Quick / Queue / Prospect / History / Settings views
- `backend/` — Go dependency sidecar (`dp-deps`): detects/installs yt-dlp, ffmpeg, ffprobe, gallery-dl, deno (pinned + SHA-256 verified)
- `pot/` — vendored Deno POT server for YouTube bot-check bypass
- `shared/` — code shared between main and renderer
- `scripts/` — build, manifest generation, release helpers
- `tests/` — unit + integration tests
- `docs/` — design docs

Full HLD/LLD live in the project's Notion design notes.

## 📄 License

MIT — see [LICENSE](LICENSE). DownVid engine attribution retained.
