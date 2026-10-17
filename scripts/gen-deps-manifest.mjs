#!/usr/bin/env node
/**
 * Generates backend/internal/manifest/assets.gen.go
 *
 * Fetches versions and SHA-256s from upstream release pages into the Go sidecar:
 *   - yt-dlp : yt-dlp-nightly-builds (nightly — site fixes land faster), official SHA2-256SUMS provided
 *   - ffmpeg : eugeneware/ffmpeg-static (static build with libmp3lame / aac / libx264), no published checksums — compute our own
 *   - gallery-dl : gdl-org/builds (nightly standalone, same reasoning as yt-dlp), no published checksums — compute our own
 *   - deno   : denoland/deno (zip packages), official <asset>.sha256sum provided
 *
 * Pin to a tag instead of "latest": installs must be reproducible and verifiable —
 * every "download" click should fetch the exact same bytes.
 *
 * Network goes through curl, not Node's fetch: Node's fetch doesn't read HTTP(S)_PROXY
 * env vars, which fails on most Chinese networks, while curl supports them natively.
 *
 * Usage:
 *   node scripts/gen-deps-manifest.mjs                 # use latest upstream versions and recompute all hashes
 *   node scripts/gen-deps-manifest.mjs --ytdlp <tag>   # pin yt-dlp tag
 *   node scripts/gen-deps-manifest.mjs --ffmpeg <tag>  # pin ffmpeg tag
 *   node scripts/gen-deps-manifest.mjs --gallerydl <tag> # pin gallery-dl tag
 *   node scripts/gen-deps-manifest.mjs --deno <tag>    # pin deno tag
 *   node scripts/gen-deps-manifest.mjs --reuse-hashes  # don't re-download existing hashes (only resolve new ones)
 *   node scripts/gen-deps-manifest.mjs --check         # light verification (for CI, no big downloads)
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'

const YTDLP_REPO = 'yt-dlp/yt-dlp-nightly-builds'
const FFMPEG_REPO = 'eugeneware/ffmpeg-static'
const GALLERYDL_REPO = 'gdl-org/builds'
const DENO_REPO = 'denoland/deno'
const OUT_FILE = path.resolve('backend/internal/manifest/assets.gen.go')

/** Asset names yt-dlp uses per platform */
const YTDLP_ASSETS = {
  'darwin/arm64': 'yt-dlp_macos',
  'darwin/x64': 'yt-dlp_macos',
  'linux/x64': 'yt-dlp_linux',
  'linux/arm64': 'yt-dlp_linux_aarch64',
  'win32/x64': 'yt-dlp.exe',
}

/** Asset names ffmpeg-static uses per platform (actual files are <name>.gz) */
const FFMPEG_ASSETS = {
  'darwin/arm64': { ffmpeg: 'ffmpeg-darwin-arm64', ffprobe: 'ffprobe-darwin-arm64' },
  'darwin/x64': { ffmpeg: 'ffmpeg-darwin-x64', ffprobe: 'ffprobe-darwin-x64' },
  'linux/x64': { ffmpeg: 'ffmpeg-linux-x64', ffprobe: 'ffprobe-linux-x64' },
  'linux/arm64': { ffmpeg: 'ffmpeg-linux-arm64', ffprobe: 'ffprobe-linux-arm64' },
  'win32/x64': { ffmpeg: 'ffmpeg-win32-x64', ffprobe: 'ffprobe-win32-x64' },
}

/**
 * Asset names gallery-dl uses per platform (gdl-org/builds nightly standalone).
 * Upstream publishes per OS (not arch): the linux build is x86_64, macos as published.
 * No upstream build for linux/arm64 — skipped here (no manifest error; fetch reports unsupported).
 */
const GALLERYDL_ASSETS = {
  'darwin/arm64': 'gallery-dl_macos',
  'darwin/x64': 'gallery-dl_macos',
  'linux/x64': 'gallery-dl_linux',
  'win32/x64': 'gallery-dl_windows.exe',
}

/** Asset names deno uses per platform (zip packages containing deno / deno.exe) */
const DENO_ASSETS = {
  'darwin/arm64': 'deno-aarch64-apple-darwin.zip',
  'darwin/x64': 'deno-x86_64-apple-darwin.zip',
  'linux/x64': 'deno-x86_64-unknown-linux-gnu.zip',
  'linux/arm64': 'deno-aarch64-unknown-linux-gnu.zip',
  'win32/x64': 'deno-x86_64-pc-windows-msvc.zip',
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const reuseHashes = args.includes('--reuse-hashes')
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

let workDir = null
const retrySignal = new Int32Array(new SharedArrayBuffer(4))
function waitBeforeRetry(seconds) {
  Atomics.wait(retrySignal, 0, 0, seconds * 1000)
}
function tmpFile(name) {
  if (!workDir) workDir = mkdtempSync(path.join(tmpdir(), 'dp-deps-'))
  return path.join(workDir, name)
}

/**
 * Fetch content with curl; redirect: 'follow' corresponds to -L.
 * Retry on network jitter — the most worry-free approach in this project.
 */
function curlFetch(url, { binary = false, retries = 6 } = {}) {
  const out = binary ? tmpFile(`dl-${createHash('sha1').update(url).digest('hex')}`) : null
  const args = ['-fsSL', '--max-time', '300', '--retry', '2']
  if (out) args.push('-o', out)
  args.push(url)

  const text = curlText(args, { retries, quiet: binary })
  return out ? readFileSync(out) : text
}

/** curl with retries: this project's network (incl. CI) sees TLS jitter; handled centrally here */
function curlText(textArgs, { retries = 5, quiet = false } = {}) {
  let lastError = ''
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return execFileSync('curl', textArgs, { encoding: 'utf8' })
    } catch (e) {
      lastError = e?.stderr?.toString().trim() || e?.message || ''
      if (attempt < retries) {
        if (!quiet) console.warn(`  ! curl attempt ${attempt} failed, retrying`)
        waitBeforeRetry(attempt * 2)
      }
    }
  }
  throw new Error(lastError || 'curl failed')
}

/** Parse `hash  filename` style checksum files */
function parseSums(text) {
  const map = new Map()
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (match) map.set(match[2].trim(), match[1].toLowerCase())
  }
  return map
}

/**
 * Resolve the latest tag.
 *
 * Don't use the GitHub API: unauthenticated calls get rate-limited (403) quickly;
 * instead read the 302 redirect target of releases/latest — stable and quota-free.
 */
function latestTag(repo) {
  let tag = ''
  try {
    // No -L: we need to capture the 302 Location to get the tag
    const location = curlText([
      '-sS', '-o', devNull, '-w', '%{redirect_url}', '--max-time', '60',
      `https://github.com/${repo}/releases/latest`,
    ], { quiet: true }).trim()
    tag = location.split('/tag/')[1] || ''
  } catch {}

  if (!tag) {
    // A few proxies follow redirects themselves: fall back to the GitHub API (may rate-limit unauthenticated, so last resort only)
    try {
      const json = curlText([
        '-fsSL', '--max-time', '60',
        `https://api.github.com/repos/${repo}/releases/latest`,
      ], { quiet: true })
      tag = JSON.parse(json).tag_name || ''
    } catch {}
  }
  if (!tag) throw new Error(`cannot determine latest tag for ${repo}; specify explicitly with --ytdlp/--ffmpeg/--gallerydl/--deno`)
  return decodeURIComponent(tag)
}

async function resolveYtDlp(tag, { withHashes }) {
  const resolvedTag = tag || latestTag(YTDLP_REPO)
  const base = `https://github.com/${YTDLP_REPO}/releases/download/${resolvedTag}`

  const assets = {}
  if (withHashes) {
    const sums = parseSums(curlFetch(`${base}/SHA2-256SUMS`))
    for (const [platform, name] of Object.entries(YTDLP_ASSETS)) {
      const hash = sums.get(name)
      if (!hash) throw new Error(`${resolvedTag}'s SHA2-256SUMS is missing ${name}`)
      assets[platform] = { name, hash }
    }
  } else {
    for (const [platform, name] of Object.entries(YTDLP_ASSETS)) {
      assets[platform] = { name, hash: '' }
    }
  }
  return { tag: resolvedTag, assets }
}

async function resolveFfmpeg(tag, { withHashes }) {
  const resolvedTag = tag || latestTag(FFMPEG_REPO)
  const base = `https://github.com/${FFMPEG_REPO}/releases/download/${resolvedTag}`

  const assets = {}
  for (const [platform, kinds] of Object.entries(FFMPEG_ASSETS)) {
    assets[platform] = {}
    for (const key of ['ffmpeg', 'ffprobe']) {
      const name = kinds[key]
      // Upstream publishes no checksums: compute after download in update mode; leave empty in reuse mode for the caller to fill
      const hash = withHashes
        ? createHash('sha256').update(curlFetch(`${base}/${name}.gz`, { binary: true })).digest('hex')
        : ''
      assets[platform][key] = { name, hash }
    }
  }
  return { tag: resolvedTag, assets }
}

async function resolveGalleryDl(tag, { withHashes }) {
  const resolvedTag = tag || latestTag(GALLERYDL_REPO)
  const base = `https://github.com/${GALLERYDL_REPO}/releases/download/${resolvedTag}`

  const assets = {}
  for (const [platform, name] of Object.entries(GALLERYDL_ASSETS)) {
    // Upstream publishes no checksums: compute after download (same pattern as ffmpeg-static)
    const hash = withHashes
      ? createHash('sha256').update(curlFetch(`${base}/${name}`, { binary: true })).digest('hex')
      : ''
    assets[platform] = { name, hash }
  }
  return { tag: resolvedTag, assets }
}

async function resolveDeno(tag, { withHashes }) {
  const resolvedTag = tag || latestTag(DENO_REPO)
  const base = `https://github.com/${DENO_REPO}/releases/download/${resolvedTag}`

  const assets = {}
  for (const [platform, name] of Object.entries(DENO_ASSETS)) {
    let hash = ''
    if (withHashes) {
      // Upstream provides a same-named .sha256sum file per zip (tiny).
      // Note: Windows artifacts use PowerShell Get-FileHash style ("Hash : <hex>"),
      // macOS/Linux use the standard "hash  filename" format — both are handled.
      const text = String(curlFetch(`${base}/${name}.sha256sum`))
      const m = text.match(/Hash\s*:\s*([0-9a-f]{64})/i)
      hash = (m?.[1] || parseSums(text).get(name) || [...parseSums(text).values()][0] || '').toLowerCase()
      if (!hash) throw new Error(`${resolvedTag}'s checksum file is missing ${name}`)
    }
    assets[platform] = { name, hash }
  }
  return { tag: resolvedTag, assets }
}

/** Read existing tags back from the generated Go file */
function readCurrentTags() {
  try {
    const src = readFileSync(OUT_FILE, 'utf8')
    return {
      ytdlp: src.match(/YtDlpTag\s*=\s*"([^"]+)"/)?.[1],
      ffmpeg: src.match(/FFmpegTag\s*=\s*"([^"]+)"/)?.[1],
      gallerydl: src.match(/GalleryDlTag\s*=\s*"([^"]+)"/)?.[1],
      deno: src.match(/DenoTag\s*=\s*"([^"]+)"/)?.[1],
    }
  } catch {
    return {}
  }
}

/** Read existing hashes back from the generated Go file (for --reuse-hashes) */
function readExistingHashes() {
  const out = { ytdlp: {}, ffmpeg: {}, gallerydl: {}, deno: {} }
  try {
    const src = readFileSync(OUT_FILE, 'utf8')
    let m
    const reYt = /"([^"]+)":\s*\{"([^"]+)", "([0-9a-f]{64})"\},/g
    const ytdlpBlock = src.match(/var ytdlpAssets = map\[string\]asset\{([\s\S]*?)\n\}/)
    if (ytdlpBlock) {
      while ((m = reYt.exec(ytdlpBlock[1])) !== null) {
        out.ytdlp[m[1]] = { name: m[2], hash: m[3] }
      }
    }
    const reFf = /\t"([^"]+)": \{\n\t\trt\.KindFFmpeg:  \{"([^"]+)", "([0-9a-f]{64})"\},\n\t\trt\.KindFFprobe: \{"([^"]+)", "([0-9a-f]{64})"\},\n\t\},/g
    const ffBlock = src.match(/var ffmpegAssets = map\[string\]map\[rt\.Kind\]asset\{([\s\S]*?)\n\}/)
    if (ffBlock) {
      while ((m = reFf.exec(ffBlock[1])) !== null) {
        out.ffmpeg[m[1]] = { ffmpeg: { name: m[2], hash: m[3] }, ffprobe: { name: m[4], hash: m[5] } }
      }
    }
    const reSimple = /"([^"]+)":\s*\{"([^"]+)", "([0-9a-f]{64})"\},/g
    for (const key of ['gallerydl', 'deno']) {
      const varName = key === 'gallerydl' ? 'gallerydlAssets' : 'denoAssets'
      const block = src.match(new RegExp(`var ${varName} = map\\[string\\]asset\\{([\\s\\S]*?)\\n\\}`))
      if (block) {
        while ((m = reSimple.exec(block[1])) !== null) {
          out[key][m[1]] = { name: m[2], hash: m[3] }
        }
      }
    }
  } catch {}
  return out
}

/** Keep existing hashes from the file in check/reuse mode */
function hFill(asset, existingMap, platform, sub) {
  if (asset.hash) return asset.hash
  const e = sub ? existingMap?.[platform]?.[sub] : existingMap?.[platform]
  return e?.hash || 'PENDING'
}

function render(ytdlp, ffmpeg, gallerydl, deno, existing) {
  const pad = (p) => ' '.repeat(Math.max(1, 15 - p.length))
  const ytdlpLines = Object.entries(ytdlp.assets)
    .map(([platform, a]) => `\t${JSON.stringify(platform)}:${pad(platform)}{"${a.name}", "${hFill(a, existing.ytdlp, platform)}"},`)
    .join('\n')

  const ffmpegLines = Object.entries(ffmpeg.assets)
    .map(([platform, kinds]) => {
      const ff = kinds.ffmpeg
      const fp = kinds.ffprobe
      return `\t${JSON.stringify(platform)}: {\n` +
        `\t\trt.KindFFmpeg:  {"${ff.name}", "${hFill(ff, existing.ffmpeg, platform, 'ffmpeg')}"},\n` +
        `\t\trt.KindFFprobe: {"${fp.name}", "${hFill(fp, existing.ffmpeg, platform, 'ffprobe')}"},\n` +
        `\t},`
    })
    .join('\n')

  const gallerydlLines = Object.entries(gallerydl.assets)
    .map(([platform, a]) => `\t${JSON.stringify(platform)}:${pad(platform)}{"${a.name}", "${hFill(a, existing.gallerydl, platform)}"},`)
    .join('\n')

  const denoLines = Object.entries(deno.assets)
    .map(([platform, a]) => `\t${JSON.stringify(platform)}:${pad(platform)}{"${a.name}", "${hFill(a, existing.deno, platform)}"},`)
    .join('\n')

  return `// Code generated by scripts/gen-deps-manifest.mjs; DO NOT EDIT.
//
// Generated by the script from upstream release pages — do not hand-edit;
// to upgrade dependencies, run: node scripts/gen-deps-manifest.mjs (or pnpm deps:manifest).

package manifest

import rt "github.com/ShahzaibRao/downpilot/backend/internal/runtime"

// YtDlpTag is the pinned tag of the yt-dlp nightly build (date version)
const YtDlpTag = "${ytdlp.tag}"

// FFmpegTag is the pinned ffmpeg-static tag
const FFmpegTag = "${ffmpeg.tag}"

// GalleryDlTag is the pinned tag of the gallery-dl nightly standalone build (date version, gdl-org/builds)
const GalleryDlTag = "${gallerydl.tag}"

// DenoTag is the pinned deno tag
const DenoTag = "${deno.tag}"

const (
\tytdlpBase     = "https://github.com/${YTDLP_REPO}/releases/download/" + YtDlpTag
\tffmpegBase    = "https://github.com/${FFMPEG_REPO}/releases/download/" + FFmpegTag
\tgallerydlBase = "https://github.com/${GALLERYDL_REPO}/releases/download/" + GalleryDlTag
\tdenoBase      = "https://github.com/${DENO_REPO}/releases/download/" + DenoTag
)

// ytdlpAssets: yt-dlp artifacts and SHA-256 per platform
var ytdlpAssets = map[string]asset{
${ytdlpLines}
}

// ffmpegAssets: ffmpeg / ffprobe artifacts and SHA-256 per platform.
//
// ffmpeg-static (static build) is chosen over BtbN: smaller, single gzip file is easy to verify,
// and it bundles libmp3lame / aac / libx264, covering both audio conversion and A/V merging.
var ffmpegAssets = map[string]map[rt.Kind]asset{
${ffmpegLines}
}

// gallerydlAssets: gallery-dl artifacts and SHA-256 per platform.
//
// Uses gdl-org/builds nightly standalone (bundles a Python interpreter — users don't install Python),
// same reasoning as yt-dlp: site fixes land faster. No upstream build for linux/arm64 — skipped at manifest generation.
var gallerydlAssets = map[string]asset{
${gallerydlLines}
}

// denoAssets: deno artifacts and SHA-256 per platform (zip packages containing deno / deno.exe).
var denoAssets = map[string]asset{
${denoLines}
}
`
}

/**
 * Check whether an artifact is downloadable.
 *
 * Use a ranged GET instead of HEAD: GitHub release HEADs redirect to
 * release-assets.githubusercontent.com, which fails to connect directly on some networks;
 * a ranged download both confirms existence and pulls just 1 byte.
 */
function assetAvailable(url) {
  const attempts = 6
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      execFileSync('curl', ['-fsSL', '-r', '0-0', '--max-time', '60', '-o', devNull, url],
        { stdio: ['ignore', 'ignore', 'pipe'] })
      return true
    } catch (e) {
      lastError = e?.stderr?.toString().trim() || e?.message || ''
      if (/404|Not Found/i.test(lastError)) return false
      if (attempt < attempts) waitBeforeRetry(attempt * 2)
    }
  }
  console.warn(`  ! cannot confirm artifact exists (network), skipping: ${url}`)
  return null
}

async function main() {
  const existingTags = readCurrentTags()
  const existing = readExistingHashes()
  console.log('checking upstream versions...')

  if (checkOnly) {
    for (const [label, repo, key] of [
      ['yt-dlp', YTDLP_REPO, 'ytdlp'],
      ['ffmpeg', FFMPEG_REPO, 'ffmpeg'],
      ['gallery-dl', GALLERYDL_REPO, 'gallerydl'],
      ['deno', DENO_REPO, 'deno'],
    ]) {
      const tag = latestTag(repo)
      console.log(`  upstream ${label} : ${tag} (local ${existingTags[key] || 'unknown'})`)
      if (tag !== existingTags[key]) {
        console.error(`\nmanifest check failed: ${label} is behind: local ${existingTags[key]} → upstream ${tag}`)
        console.error('run `pnpm deps:manifest` to update the manifest.')
        process.exit(1)
      }
    }
    console.log('manifest matches upstream')
    return
  }

  // --reuse-hashes: don't re-download existing hashes, only resolve new ones
  const skipBig = reuseHashes
  const ytdlp = await resolveYtDlp(argValue('--ytdlp') || existingTags.ytdlp, { withHashes: !skipBig })
  const ffmpeg = await resolveFfmpeg(argValue('--ffmpeg') || existingTags.ffmpeg, { withHashes: !skipBig })
  const gallerydl = await resolveGalleryDl(argValue('--gallerydl') || existingTags.gallerydl, { withHashes: true })
  const deno = await resolveDeno(argValue('--deno') || existingTags.deno, { withHashes: true })
  console.log(`  yt-dlp : ${ytdlp.tag}`)
  console.log(`  ffmpeg : ${ffmpeg.tag}`)
  console.log(`  gallery-dl : ${gallerydl.tag}`)
  console.log(`  deno : ${deno.tag}`)

  writeFileSync(OUT_FILE, render(ytdlp, ffmpeg, gallerydl, deno, existing), 'utf8')
  console.log(`wrote ${path.relative(process.cwd(), OUT_FILE)}`)
}

main()
  .catch((e) => {
    console.error(`generation failed: ${e.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })
