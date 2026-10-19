# DownPilot User Guide

## Quick Start

### Download & Install
1. Go to [GitHub Releases](https://github.com/ShahzaibRao/downpilot/releases)
2. Download `DownPilot-Setup-0.1.2.exe`
3. Run the installer. If Windows SmartScreen appears: **More info → Run anyway** (the app is unsigned in v1, this is expected)

### First Download
1. Open DownPilot → **Quick** tab
2. Paste any video URL (YouTube, TikTok, Instagram, X, Snapchat)
3. Platform is auto-detected (colored badge appears)
4. Choose quality → **Download**

## Tabs

### 📊 Dashboard
Your stats at a glance: total downloads, storage used, top speed, success rate, live speed graph, platform breakdown, top creators, 7-day activity chart, recent downloads.

### ⚡ Quick
Paste links to download immediately.
- **Scope**: single video, playlist, or channel
- **Bulk add**: paste multiple URLs, duplicates auto-skipped
- Platform badge shows auto-detected site

### 📋 Queue
Manage active downloads. Filter by all/active/done/failed. Pause, resume, retry. 🧹 button clears completed.

### 👁️ Prospect
Auto-watch creators for new content.

**Add a prospect:**
1. Paste a profile URL (e.g. `https://www.tiktok.com/@someone`)
2. Name is optional (auto-filled from URL)
3. Choose quality + check interval (15 min – 24 hours)
4. **Add**

**Multi-platform:** One prospect can track multiple links (e.g. someone's TikTok + Instagram + YouTube) — all download to one folder: `Downloads/DownPilot/prospects/<name>/`.

**How it works:**
- First check: downloads the 3 latest items (Instagram: 6, to skip pinned posts)
- After that: only NEW content since last check
- Snapchat stories: ALL active stories download (they expire in 24h!)
- Seen-tracking by content ID — **deleted files are never re-downloaded**

**Per-link status:** Each link shows ✓ (ok), ✗ (n/3 errors), or ⏸ (paused after 3 fails). Click Resume to retry a paused link.

**Tips:**
- Click a prospect card to expand details
- 📁 **Open** button opens the download folder in Explorer
- Use search, filters, and sort to manage many prospects
- Select multiple with checkboxes for bulk check/pause/resume/remove

### 📜 History
Last 100 finished downloads. Search by filename/URL, filter by done/failed, re-download with one click. 🧹 clears all.

### 🎨 Appearance (in Settings)
- **Theme**: Light / Dark / System (follows Windows)
- **Accent color**: 8 presets + custom color picker

### ⚙️ Settings

**Downloads:** Folder location, simultaneous downloads (1–8), max new items per prospect check.

**Smart Mode:** Route *extraction* through your proxy (for blocked sites), download *direct* for speed. Add proxies, select per platform.

**POT Server:** Deno-powered token server for YouTube bot-checks. Starts automatically. Usually you don't need to touch this.

**Cookie profiles:** For login-walled content:
1. Log in to the site in your browser
2. Export `cookies.txt` (Netscape format) via a browser extension
3. Import in DownPilot per platform

**Runtime dependencies:** yt-dlp, ffmpeg, ffprobe, gallery-dl, deno. Auto-managed by the Go sidecar with SHA-256 verification. Download missing ones with one click.

**App Updates:** Version info, update status, manual check button.

## FAQ

**Q: Download failed — what do I do?**
- Check the error message in Queue/History
- Login-walled? Add cookies for that platform
- Region-blocked? Enable Smart Mode with a proxy
- Still failing? The site may have changed — check GitHub issues

**Q: Prospect not finding new content?**
- Click **Check** to force a check
- Check per-link status — a link may be paused after 3 failures
- Verify the profile URL is correct

**Q: How do updates work?**
Settings → App Updates → Check for updates. Or wait — the app checks automatically on startup and daily. Updates download in background; you'll be asked before restarting.

**Q: Where are files saved?**
Default: `Downloads/DownPilot/`
- Quick downloads: directly in that folder
- Prospect downloads: `prospects/<creator-name>/`

**Q: Can I move the download folder?**
Yes: Settings → Downloads → Change folder.
