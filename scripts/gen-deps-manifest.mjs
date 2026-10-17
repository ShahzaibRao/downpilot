#!/usr/bin/env node
/**
 * 生成 backend/internal/manifest/assets.gen.go
 *
 * 从上游发布页抓取版本号与 SHA-256，写进 Go 侧车：
 *   - yt-dlp : yt-dlp-nightly-builds（nightly，站点修复更及时），官方提供 SHA2-256SUMS
 *   - ffmpeg : eugeneware/ffmpeg-static（静态构建，含 libmp3lame / aac / libx264），无校验值需自算
 *   - gallery-dl : gdl-org/builds（nightly standalone，yt-dlp 同一思路），无校验值需自算
 *   - deno   : denoland/deno（zip 包），官方提供 <asset>.sha256sum
 *
 * 固定到某个 tag 而不是 "latest"：安装结果必须可复现、可校验，
 * 用户每次点"下载"都应拿到同一份字节串。
 *
 * 网络统一走 curl 而不是 Node 的 fetch：Node 的 fetch 不读取 HTTP(S)_PROXY
 * 环境变量，在国内网络下几乎必失败，而 curl 原生支持。
 *
 * 用法：
 *   node scripts/gen-deps-manifest.mjs                 # 使用上游最新版本并重算全部哈希
 *   node scripts/gen-deps-manifest.mjs --ytdlp <tag>   # 固定 yt-dlp tag
 *   node scripts/gen-deps-manifest.mjs --ffmpeg <tag>  # 固定 ffmpeg tag
 *   node scripts/gen-deps-manifest.mjs --gallerydl <tag> # 固定 gallery-dl tag
 *   node scripts/gen-deps-manifest.mjs --deno <tag>    # 固定 deno tag
 *   node scripts/gen-deps-manifest.mjs --reuse-hashes  # 已有哈希不再重新下载（只新增缺失项）
 *   node scripts/gen-deps-manifest.mjs --check         # 轻量校验（CI 用，不重新下载大文件）
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

/** yt-dlp 各平台使用的产物名 */
const YTDLP_ASSETS = {
  'darwin/arm64': 'yt-dlp_macos',
  'darwin/x64': 'yt-dlp_macos',
  'linux/x64': 'yt-dlp_linux',
  'linux/arm64': 'yt-dlp_linux_aarch64',
  'win32/x64': 'yt-dlp.exe',
}

/** ffmpeg-static 各平台使用的产物名（实际文件为 <name>.gz） */
const FFMPEG_ASSETS = {
  'darwin/arm64': { ffmpeg: 'ffmpeg-darwin-arm64', ffprobe: 'ffprobe-darwin-arm64' },
  'darwin/x64': { ffmpeg: 'ffmpeg-darwin-x64', ffprobe: 'ffprobe-darwin-x64' },
  'linux/x64': { ffmpeg: 'ffmpeg-linux-x64', ffprobe: 'ffprobe-linux-x64' },
  'linux/arm64': { ffmpeg: 'ffmpeg-linux-arm64', ffprobe: 'ffprobe-linux-arm64' },
  'win32/x64': { ffmpeg: 'ffmpeg-win32-x64', ffprobe: 'ffprobe-win32-x64' },
}

/**
 * gallery-dl 各平台使用的产物名（gdl-org/builds 的 nightly standalone）。
 * 上游按 OS（不分 arch）发布：linux 构建为 x86_64，macos 构建以实际为准。
 * linux/arm64 上游无构建，此处跳过（manifest 生成时不报错，fetch 时提示不支持）。
 */
const GALLERYDL_ASSETS = {
  'darwin/arm64': 'gallery-dl_macos',
  'darwin/x64': 'gallery-dl_macos',
  'linux/x64': 'gallery-dl_linux',
  'win32/x64': 'gallery-dl_windows.exe',
}

/** deno 各平台使用的产物名（zip 包，内含 deno / deno.exe） */
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
 * 用 curl 抓取内容；redirect: 'follow' 对应 -L。
 * 网络抖动时重试，这是本项目里最省心的做法。
 */
function curlFetch(url, { binary = false, retries = 6 } = {}) {
  const out = binary ? tmpFile(`dl-${createHash('sha1').update(url).digest('hex')}`) : null
  const args = ['-fsSL', '--max-time', '300', '--retry', '2']
  if (out) args.push('-o', out)
  args.push(url)

  const text = curlText(args, { retries, quiet: binary })
  return out ? readFileSync(out) : text
}

/** 带重试的 curl：本项目的网络（含 CI）会出现 TLS 抖动，统一在这里兜住 */
function curlText(textArgs, { retries = 5, quiet = false } = {}) {
  let lastError = ''
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return execFileSync('curl', textArgs, { encoding: 'utf8' })
    } catch (e) {
      lastError = e?.stderr?.toString().trim() || e?.message || ''
      if (attempt < retries) {
        if (!quiet) console.warn(`  ! curl 第 ${attempt} 次失败，重试中`)
        waitBeforeRetry(attempt * 2)
      }
    }
  }
  throw new Error(lastError || 'curl 执行失败')
}

/** 解析 `hash  filename` 形式的校验文件 */
function parseSums(text) {
  const map = new Map()
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i)
    if (match) map.set(match[2].trim(), match[1].toLowerCase())
  }
  return map
}

/**
 * 取最新 tag。
 *
 * 不用 GitHub API：未认证时很快会被限流（403），
 * 改为读 releases/latest 的 302 跳转地址，稳定且无配额。
 */
function latestTag(repo) {
  let tag = ''
  try {
    // 不带 -L：需要捕获 302 的 Location 才能拿到 tag
    const location = curlText([
      '-sS', '-o', devNull, '-w', '%{redirect_url}', '--max-time', '60',
      `https://github.com/${repo}/releases/latest`,
    ], { quiet: true }).trim()
    tag = location.split('/tag/')[1] || ''
  } catch {}

  if (!tag) {
    // 少数代理会直接跟随跳转：退回 GitHub API（未认证时可能限流，故仅作兜底）
    try {
      const json = curlText([
        '-fsSL', '--max-time', '60',
        `https://api.github.com/repos/${repo}/releases/latest`,
      ], { quiet: true })
      tag = JSON.parse(json).tag_name || ''
    } catch {}
  }
  if (!tag) throw new Error(`无法确定 ${repo} 的最新 tag，请用 --ytdlp/--ffmpeg/--gallerydl/--deno 显式指定`)
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
      if (!hash) throw new Error(`${resolvedTag} 的 SHA2-256SUMS 中缺少 ${name}`)
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
      // 上游不公布校验值：更新模式下下载后自算，复用模式下留空由调用方回填
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
    // 上游不公布校验值：下载后自算（与 ffmpeg-static 同一模式）
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
      // 官方为每个 zip 提供同名的 .sha256sum 文件（体积很小）。
      // 注意：Windows 产物是 PowerShell Get-FileHash 风格（"Hash : <hex>"），
      // macOS/Linux 是标准 "hash  filename" 格式——两种都兼容。
      const text = String(curlFetch(`${base}/${name}.sha256sum`))
      const m = text.match(/Hash\s*:\s*([0-9a-f]{64})/i)
      hash = (m?.[1] || parseSums(text).get(name) || [...parseSums(text).values()][0] || '').toLowerCase()
      if (!hash) throw new Error(`${resolvedTag} 的校验文件中缺少 ${name}`)
    }
    assets[platform] = { name, hash }
  }
  return { tag: resolvedTag, assets }
}

/** 从已生成的 Go 文件里读回现有 tag */
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

/** 从已生成的 Go 文件里读回现有哈希（--reuse-hashes 用） */
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

/** 校验/复用模式下保留文件里已有的哈希 */
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
// 由脚本从上游发布页抓取版本号与 SHA-256 后生成，请勿手改；
// 升级依赖请运行：node scripts/gen-deps-manifest.mjs（或 pnpm deps:manifest）。

package manifest

import rt "github.com/ShahzaibRao/downpilot/backend/internal/runtime"

// YtDlpTag yt-dlp nightly 构建的固定 tag（日期版本号）
const YtDlpTag = "${ytdlp.tag}"

// FFmpegTag ffmpeg-static 的固定 tag
const FFmpegTag = "${ffmpeg.tag}"

// GalleryDlTag gallery-dl nightly standalone 构建的固定 tag（日期版本号，gdl-org/builds）
const GalleryDlTag = "${gallerydl.tag}"

// DenoTag deno 的固定 tag
const DenoTag = "${deno.tag}"

const (
\tytdlpBase     = "https://github.com/${YTDLP_REPO}/releases/download/" + YtDlpTag
\tffmpegBase    = "https://github.com/${FFMPEG_REPO}/releases/download/" + FFmpegTag
\tgallerydlBase = "https://github.com/${GALLERYDL_REPO}/releases/download/" + GalleryDlTag
\tdenoBase      = "https://github.com/${DENO_REPO}/releases/download/" + DenoTag
)

// ytdlpAssets yt-dlp 在各平台的产物与 SHA-256
var ytdlpAssets = map[string]asset{
${ytdlpLines}
}

// ffmpegAssets ffmpeg / ffprobe 在各平台的产物与 SHA-256。
//
// 选用 ffmpeg-static（静态构建）而非 BtbN：体积更小、gzip 单文件便于校验，
// 且带 libmp3lame / aac / libx264，覆盖音频转换与音视频合并两种用途。
var ffmpegAssets = map[string]map[rt.Kind]asset{
${ffmpegLines}
}

// gallerydlAssets gallery-dl 在各平台的产物与 SHA-256。
//
// 选用 gdl-org/builds 的 nightly standalone（含 Python 解释器，无需用户装 Python），
// 与 yt-dlp 同一思路：站点修复更及时。linux/arm64 上游无构建， manifest 生成时跳过。
var gallerydlAssets = map[string]asset{
${gallerydlLines}
}

// denoAssets deno 在各平台的产物与 SHA-256（zip 包，内含 deno / deno.exe）。
var denoAssets = map[string]asset{
${denoLines}
}
`
}

/**
 * 判断产物是否可下载。
 *
 * 用带 Range 的 GET 而不是 HEAD：GitHub Release 的 HEAD 会跳到
 * release-assets.githubusercontent.com，部分网络下该主机直连会失败；
 * 而范围下载既能确认文件存在，又能只拉 1 字节。
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
  console.warn(`  ! 无法确认产物是否存在（网络原因），跳过：${url}`)
  return null
}

async function main() {
  const existingTags = readCurrentTags()
  const existing = readExistingHashes()
  console.log('检查上游版本...')

  if (checkOnly) {
    for (const [label, repo, key] of [
      ['yt-dlp', YTDLP_REPO, 'ytdlp'],
      ['ffmpeg', FFMPEG_REPO, 'ffmpeg'],
      ['gallery-dl', GALLERYDL_REPO, 'gallerydl'],
      ['deno', DENO_REPO, 'deno'],
    ]) {
      const tag = latestTag(repo)
      console.log(`  上游 ${label} : ${tag}（本地 ${existingTags[key] || '未知'}）`)
      if (tag !== existingTags[key]) {
        console.error(`\n清单校验未通过：${label} 版本落后：本地 ${existingTags[key]} → 上游 ${tag}`)
        console.error('运行 `pnpm deps:manifest` 更新清单。')
        process.exit(1)
      }
    }
    console.log('清单与上游一致')
    return
  }

  // --reuse-hashes：已有哈希不再重新下载，只解析新增项
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
  console.log(`已写入 ${path.relative(process.cwd(), OUT_FILE)}`)
}

main()
  .catch((e) => {
    console.error(`生成失败：${e.message}`)
    process.exitCode = 1
  })
  .finally(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })
