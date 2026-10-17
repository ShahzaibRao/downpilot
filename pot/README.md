# POT (Proof-of-Origin Token) server — vendored

## What this is

`server/` is the HTTP token server and `plugins/` the yt-dlp provider plugin,
both taken from **bgutil-ytdlp-pot-provider** v2.0.2
(https://github.com/Brainicism/bgutil-ytdlp-pot-provider),
licensed **GPL-3.0-only** (see LICENSE below).

It runs as a **separate OS process** (Deno), exactly like the ffmpeg/ffprobe
binaries we already ship — it is not linked into DownPilot's code.

## Why

YouTube increasingly requires PO Tokens ("prove you're not a bot") before
serving video data. yt-dlp asks this server to mint tokens via YouTube's
BotGuard challenge. Without it, YouTube downloads fail with
"Sign in to confirm you're not a bot" on flagged networks/IPs.

Note: a PO token does **not** bypass IP-based login walls — for those,
per-platform cookie profiles (Phase 2a) are still the answer. The two
complement each other.

## Layout

- `server/` — Deno TypeScript server (listens on 127.0.0.1:4416)
  - `src/main.ts` — entrypoint (`--port`, `--host` flags)
  - `deno.json` / `deno.lock` / `package.json` — pinned npm dependencies
- `plugins/potplugin/yt_dlp_plugins/` — Python provider plugin, loaded by
  yt-dlp via `--plugin-dirs`. Registers `bgutil:http` (default base URL
  http://127.0.0.1:4416), `bgutil:script-node`, `bgutil:script-deno`.

## Runtime behavior (see electron/pot.ts)

1. First YouTube download → server source is copied to
   `<userData>/pot-server/`, `deno install --frozen` runs once (npm deps),
   then `deno run` starts the server.
2. `GET /ping` health check; existing server on :4416 is reused.
3. Killed on app quit.

## License

```
bgutil-ytdlp-pot-provider — Copyright (c) Brainicism and contributors
SPDX-License-Identifier: GPL-3.0-only
```

Full license text: https://github.com/Brainicism/bgutil-ytdlp-pot-provider/blob/main/LICENSE
Upstream changes should be re-vendored (not hand-patched) to stay in sync.
