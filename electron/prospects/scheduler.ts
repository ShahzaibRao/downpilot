import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { Prospect } from './store'
import type { ProspectStore } from './store'
import type { SeenStore } from './seen'
import type { QueueManager } from '../download/queue'
import type { Tools } from '../download/engine'

const execFileAsync = promisify(execFile)

/** Log with [prospect] prefix — visible in terminal via `npm run dev`. */
function log(...args: unknown[]): void {
  console.log('[prospect]', ...args)
}

/** Log a full exec failure for tracing (command + stdout tail + stderr tail). */
function logExecFailure(label: string, e: any): void {
  const stdout = (e.stdout || '').toString().trim()
  const stderr = (e.stderr || '').toString().trim()
  log(`${label} FAILED:`)
  // last 5 lines of stderr (where the real error usually is)
  const errLines = stderr.split('\n').filter((l: string) => l.trim()).slice(-5)
  for (const l of errLines) log(`  stderr: ${l.trim()}`)
  const outLines = stdout.split('\n').filter((l: string) => l.trim()).slice(-3)
  for (const l of outLines) log(`  stdout: ${l.trim().slice(0, 200)}`)
  if (!errLines.length && !outLines.length) {
    log(`  message: ${(e.message || '').toString().slice(0, 500)}`)
  }
}

export interface ProspectItem {
  id: string
  title: string
  url: string
  /** Snapchat stories expire in 24h — download ALL, bypass maxNew limit. */
  isStory?: boolean
  /** Instagram pinned posts — skip download, but mark seen. */
  isPinned?: boolean
  /** X/Twitter: date string for chronological sorting (newest first). */
  date?: string
}

export interface CheckResult {
  prospectId: string
  prospectName: string
  newItems: number
  queued: number
  error?: string
}

/** 60 minutes default; scheduler ticks every 5 min and checks due prospects. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
const TICK_MS = 5 * 60 * 1000
/** perf/stagger-checks: cap automatic-tick batch so 70+ prospects don't spike CPU. */
const MAX_PER_TICK = 10
/** perf/stagger-checks: idle gap between prospects in one tick. */
const GAP_MS = 5 * 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Max new items per prospect per check (configurable later). */
export const DEFAULT_MAX_NEW = 20

/**
 * List recent items for a profile URL via yt-dlp flat playlist.
 * Returns up to `limit` items (newest first).
 */
export async function listItems(
  ytDlpPath: string,
  url: string,
  limit: number,
  cookiesFile?: string | null,
  proxyUrl?: string | null
): Promise<ProspectItem[]> {
  const args = [
    '--flat-playlist',
    '--no-warnings',
    '--no-check-certificates',
    '--print',
    '%(id)s|%(title)s|%(webpage_url)s',
    '--playlist-end',
    String(limit),
    url
  ]
  if (cookiesFile) args.push('--cookies', cookiesFile)
  if (proxyUrl) args.push('--proxy', proxyUrl)

  const { stdout } = await execFileAsync(ytDlpPath, args, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  })

  const items: ProspectItem[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('|')
    if (parts.length < 3) continue
    const [id, title, itemUrl] = parts
    if (!id || !itemUrl || !itemUrl.startsWith('http')) continue
    items.push({ id: id.trim(), title: (title || id).trim(), url: itemUrl.trim() })
  }
  return items
}

/**
 * Snapchat listing via __NEXT_DATA__ (CreatorWatch approach).
 * gallery-dl's Snapchat extractor is outdated; yt-dlp gives wrong content.
 * We fetch the profile page and parse stories + spotlight directly,
 * returning DIRECT media URLs (cf-st.sc-cdn.net) for download.
 */
export async function listSnapchat(
  url: string,
  limit: number,
  cookiesFile?: string | null,
  proxyUrl?: string | null
): Promise<ProspectItem[]> {
  const m = url.match(/snapchat\.com\/(?:@|add\/)([^/?#]+)/i)
  if (!m) throw new Error(`Snapchat URL samajh nahi aayi: ${url}`)
  const user = m[1]
  const pageUrl = `https://www.snapchat.com/@${user}`

  log(`listing snapchat via __NEXT_DATA__: ${pageUrl}`)

  // Use curl (not Node fetch) — handles proxies, DNS, TLS better on Windows.
  // (Smart Mode proxy support via -x flag.)
  const curlArgs = [
    '-sL',           // silent, follow redirects
    '--max-time', '30',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    '-H', 'Referer: https://www.snapchat.com/',
  ]
  if (proxyUrl) {
    curlArgs.push('-x', proxyUrl)
  }
  if (cookiesFile) {
    // Let curl read the Netscape cookie file directly (more robust than manual header)
    curlArgs.push('-b', cookiesFile)
  }
  curlArgs.push(pageUrl)

  let html: string
  try {
    const { stdout } = await execFileAsync('curl', curlArgs, {
      timeout: 35000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    })
    html = stdout
  } catch (e: any) {
    const stderr = (e.stderr || '').toString().slice(0, 300)
    throw new Error(`curl failed: ${(e as Error).message}${stderr ? ` | stderr: ${stderr}` : ''}`)
  }
  if (!html || !html.includes('__NEXT_DATA__')) {
    throw new Error('Snapchat page ka data nahi mila — page khali ya structure badal gayi?')
  }

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)
  if (!nextDataMatch) throw new Error('Snapchat page ka data nahi mila — structure badal gayi?')

  let pp: any
  try {
    pp = JSON.parse(nextDataMatch[1]).props.pageProps
  } catch (e) {
    throw new Error(`Snapchat JSON parse fail: ${(e as Error).message}`)
  }

  const val = (x: any) => (x && typeof x === 'object' ? (x.value ?? x) : x)
  const items: ProspectItem[] = []
  const seen = new Set<string>()

  const addSnap = (snap: any, prefix: string, isStory: boolean) => {
    const urls = snap.snapUrls || {}
    const media = urls.mediaUrl
    if (!media || seen.has(media)) return
    seen.add(media)
    const sid = String(val(snap.snapId) || '').slice(0, 60) || media.slice(-30)
    const title = String(val(snap.snapTitle) || '').slice(0, 80) || sid
    items.push({
      id: `sc_${sid}`,
      title: `${prefix}: ${title}`.slice(0, 100),
      url: media,  // DIRECT CDN URL — download via yt-dlp as generic file
      isStory
    })
  }

  // 1. Active Story (24h) — first! ALL of them (they expire).
  const story = pp.story
  if (story && typeof story === 'object') {
    for (const snap of story.snapList || []) {
      addSnap(snap, 'Story', true)
      if (items.length >= limit) break
    }
  }

  // 2. Spotlight + Curated Highlights
  for (const key of ['spotlightHighlights', 'curatedHighlights']) {
    for (const hl of pp[key] || []) {
      const hlTitle = String(val(hl.storyTitle) || '').slice(0, 40)
      for (const snap of hl.snapList || []) {
        const urls = snap.snapUrls || {}
        const media = urls.mediaUrl
        if (!media || seen.has(media)) continue
        seen.add(media)
        const sid = String(val(snap.snapId) || '').slice(0, 60) || media.slice(-30)
        const title = String(val(snap.snapTitle) || hlTitle || '').slice(0, 80) || sid
        items.push({
          id: `sc_${sid}`,
          title: (key === 'spotlightHighlights' ? 'Spotlight' : 'Highlight') + `: ${title}`.slice(0, 100),
          url: media,
          isStory: false
        })
        if (items.length >= limit) break
      }
      if (items.length >= limit) break
    }
    if (items.length >= limit) break
  }

  if (items.length === 0) {
    throw new Error(`@${user}: Snapchat web par koi public content nahi — shayad app-only hai`)
  }

  log(`snapchat __NEXT_DATA__: ${items.length} items (stories + spotlight)`)
  return items
}
export async function listItemsGalleryDl(
  gdlPath: string,
  url: string,
  platform: string,
  limit: number,
  cookiesFile?: string | null,
  proxyUrl?: string | null
): Promise<ProspectItem[]> {
  // CreatorWatch formats: shortcode/post_url for IG, tweet_id for X
  let printFmt: string
  let targetUrl = url
  let extraUrls: string[] = []
  if (platform === 'instagram') {
    // Try multiple possible pinned field names; log raw for debugging.
    // Instagram allows max 3 pinned posts, always at the top.
    printFmt = '{shortcode} :: {post_url} :: {caption} :: {pinned} :: {is_pinned}'
    targetUrl = url.replace(/\/$/, '') + '/'  // trailing slash needed
    // Also list reels tab — gallery-dl's user extractor may miss reels!
    // (User wants ALL latest uploads: posts + reels)
    const reelsUrl = url.replace(/\/$/, '') + '/reels/'
    if (reelsUrl !== targetUrl) extraUrls.push(reelsUrl)
  } else if (platform === 'x') {
    // Include date for chronological sorting (CreatorWatch format)
    printFmt = '{tweet_id} :: {date} :: {content}'
    // Use /media tab — shows ONLY posts with images/videos, in chronological order.
    // (Profile URL includes text-only tweets which we don't want.)
    const mediaUrl = url.replace(/\/$/, '') + '/media'
    targetUrl = mediaUrl
    log(`x: using media tab: ${mediaUrl}`)
  } else if (platform === 'tiktok') {
    printFmt = '{id} :: {title}'
  } else if (platform === 'snapchat') {
    printFmt = '{id} :: {title} :: {webpage_url} :: {date}'
  } else {
    printFmt = '{id} :: {title} :: {webpage_url}'
  }

  const args = [
    '--print', printFmt,
    '--range', `1-${limit}`,
    '--no-mtime',
  ]
  if (cookiesFile) args.push('--cookies', cookiesFile)
  if (proxyUrl) args.push('--proxy', proxyUrl)

  // Run for target + extra URLs (e.g. IG posts + reels), merge results.
  const allUrls = [targetUrl, ...extraUrls]
  let stdout = ''
  for (const u of allUrls) {
    try {
      const { stdout: out } = await execFileAsync(gdlPath, [...args, u], {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      })
      stdout += out + '\n'
      if (u !== targetUrl) log(`gallery-dl extra URL (${u}): got output`)
    } catch (e) {
      // Extra URLs (reels tab) may fail — don't break the main listing.
      if (u === targetUrl) throw e
      log(`gallery-dl extra URL failed (skipped): ${u} — ${(e as Error).message.slice(0, 100)}`)
    }
  }

  const username = extractUsername(url)
  const items: ProspectItem[] = []
  const seen = new Set<string>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(' :: ')
    if (parts.length < 2) continue
    const parsed = parseGalleryPrint(parts, platform, username)
    if (!parsed) continue
    // Deduplicate by POST (not by image): a carousel post has multiple images
    // but is ONE post. Use the post URL as the key — one URL = one queue item.
    // (gallery-dl downloads all carousel images when given the post URL.)
    const dedupKey = platform === 'instagram' ? parsed.url : parsed.id
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey)
      items.push(parsed)
      if (items.length >= limit) break
    }
  }
  log(`gallery-dl: ${items.length} items parsed for ${platform}`)
  return items
}

/** Parse one --print line into a ProspectItem. */
let _pinDebugLogged = false
export function parseGalleryPrint(parts: string[], platform: string, username: string): ProspectItem | null {
  if (platform === 'instagram') {
    // "{shortcode} :: {post_url} :: {caption} :: {pinned} :: {is_pinned}"
    const [shortcode, postUrl, caption, pinned, isPinned] = parts
    if (!postUrl?.trim().startsWith('http')) return null
    // ID is based on POST (not image): extract post ID from URL.
    // e.g. https://www.instagram.com/p/ABC123/ → ig_ABC123
    // This ensures one carousel post = one ID, no matter how many images.
    const urlMatch = postUrl.match(/instagram\.com\/(?:p|reel)\/([^/?#]+)/i)
    const postId = urlMatch ? urlMatch[1] : (shortcode?.trim() || postUrl.trim())
    // Skip pinned posts — they're always on top, would block real latest posts.
    // Try multiple field names; gallery-dl version differences.
    const pinVal = (pinned || '').trim() + '|' + (isPinned || '').trim()
    const isPin = /^(true|1|yes)/i.test(pinVal)
    // Debug: log the raw pinned values for first item
    if (!_pinDebugLogged) {
      _pinDebugLogged = true
      console.log(`[prospect] IG pinned debug: pinned="${pinned}" is_pinned="${isPinned}" → isPin=${isPin}`)
    }
    return {
      id: `ig_${postId}`,
      title: (caption?.trim() || postId).slice(0, 100),
      url: postUrl.trim(),
      isPinned: isPin
    }
  }
  if (platform === 'x') {
    // "{tweet_id} :: {date} :: {content}" → use /i/web/status/ (NOT /i/status/!)
    const [tweetId, dateStr, content] = parts
    const tid = tweetId?.trim()
    if (!tid || !/^\d+$/.test(tid)) return null
    return {
      id: `x_${tid}`,
      title: (content?.trim() || tid).slice(0, 100),
      url: `https://x.com/i/web/status/${tid}`,
      // Store date for chronological sorting (newest first)
      date: dateStr?.trim() || ''
    }
  }
  if (platform === 'tiktok') {
    // "{id} :: {title}"
    const [id, title] = parts
    const vid = id?.trim()
    if (!vid || vid === '0') return null
    return {
      id: `tt_${vid}`,
      title: (title?.trim() || vid).slice(0, 100),
      url: username
        ? `https://www.tiktok.com/@${username}/video/${vid}`
        : `https://www.tiktok.com/video/${vid}`
    }
  }
  if (platform === 'snapchat') {
    // "{id} :: {title} :: {webpage_url} :: {date}"
    const [id, title, pageUrl] = parts
    const sid = id?.trim()
    if (!sid) return null
    const purl = pageUrl?.trim()
    return {
      id: `sc_${sid}`,
      title: (title?.trim() || sid).slice(0, 100),
      url: purl?.startsWith('http') ? purl : `https://www.snapchat.com/@${username}`
    }
  }
  // generic: "{id} :: {title} :: {webpage_url}"
  const [id, title, pageUrl] = parts
  const gid = id?.trim()
  if (!gid) return null
  return {
    id: `${platform}_${gid}`,
    title: (title?.trim() || gid).slice(0, 100),
    url: pageUrl?.trim().startsWith('http') ? pageUrl.trim() : ''
  }
}

/** username/handle from a profile URL (for building TikTok video URLs). */
function extractUsername(url: string): string {
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    const at = segs.find((s) => s.startsWith('@'))
    if (at) return at.slice(1)
    return segs[0] || ''
  } catch {
    return ''
  }
}

/** Parse one gallery-dl --dump-json object into a ProspectItem. */

/**
 * List with fallback: yt-dlp first, gallery-dl second.
 * Throws combined error only if BOTH fail (Phase 1b rule).
 */
export async function listWithFallback(
  tools: Tools,
  url: string,
  platform: string,
  limit: number,
  cookiesFile?: string | null,
  proxyUrl?: string | null
): Promise<ProspectItem[]> {
  // Snapchat: use __NEXT_DATA__ directly (CreatorWatch approach).
  // gallery-dl's extractor is outdated, yt-dlp returns wrong content.
  // NO fallback to gallery-dl/yt-dlp — their IDs are incompatible with
  // __NEXT_DATA__ IDs, causing duplicate downloads. If __NEXT_DATA__ fails,
  // report the error clearly.
  if (platform === 'snapchat') {
    log(`listing ${platform} via __NEXT_DATA__: ${url}`)
    try {
      const items = await listSnapchat(url, limit, cookiesFile, proxyUrl)
      log(`snapchat OK: ${items.length} items`)
      return items
    } catch (e) {
      logExecFailure('snapchat __NEXT_DATA__', e)
      throw new Error(`${platform}: __NEXT_DATA__ failed: ${cleanError((e as Error).message)}`)
    }
  }

  // Gallery-dl has better extractors for instagram/x (CreatorWatch approach).
  // Try it FIRST for those; yt-dlp first for others.
  const gdlFirst = platform === 'instagram' || platform === 'x'

  const tryYtDlp = async (): Promise<ProspectItem[]> => {
    if (!tools.ytdlp) throw new Error('yt-dlp not available')
    log(`listing ${platform} via yt-dlp: ${url}`)
    const items = await listItems(tools.ytdlp, url, limit, cookiesFile, proxyUrl)
    log(`yt-dlp OK: ${items.length} items`)
    return items
  }

  const tryGdl = async (): Promise<ProspectItem[]> => {
    if (!tools.gallerydl) throw new Error('gallery-dl not available')
    log(`listing ${platform} via gallery-dl: ${url}`)
    const items = await listItemsGalleryDl(tools.gallerydl, url, platform, limit, cookiesFile, proxyUrl)
    log(`gallery-dl OK: ${items.length} items`)
    return items
  }

  let firstErr: Error | null = null
  let secondErr: Error | null = null

  if (gdlFirst) {
    try {
      return await tryGdl()
    } catch (e) {
      firstErr = e as Error
      logExecFailure('gallery-dl', e)
    }
    try {
      return await tryYtDlp()
    } catch (e) {
      secondErr = e as Error
      logExecFailure('yt-dlp', e)
    }
  } else {
    try {
      return await tryYtDlp()
    } catch (e) {
      firstErr = e as Error
      logExecFailure('yt-dlp', e)
    }
    try {
      return await tryGdl()
    } catch (e) {
      secondErr = e as Error
      logExecFailure('gallery-dl', e)
    }
  }

  const firstMsg = firstErr ? cleanError(firstErr.message) : 'not available'
  const secondMsg = secondErr ? cleanError(secondErr.message) : 'not available'
  const firstLabel = gdlFirst ? 'gallery-dl' : 'yt-dlp'
  const secondLabel = gdlFirst ? 'yt-dlp' : 'gallery-dl'
  throw new Error(`${platform}: ${firstLabel}: ${firstMsg} | ${secondLabel}: ${secondMsg}`)
}

export interface SchedulerDeps {
  getTools: () => Promise<Tools>
  getStore: () => ProspectStore
  getSeen: () => SeenStore
  getQueue: () => QueueManager
  /** Base download dir; prospect folder is <dir>/prospects/<folder>. */
  getDownloadDir: () => string
  getCookiesFile: (platform: string) => string | null
  getProxyUrl: (url: string) => string | null
  getMaxNew: () => number
  onCheckDone?: (results: CheckResult[]) => void
}

/**
 * Auto-watch scheduler. Every 60 min, checks each 'ok' prospect for
 * new content, queues downloads for unseen items (max 20/check).
 */
export class ProspectScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return
    // tick every 5 min; each prospect checked per its own interval (default 60)
    const tick = () => void this.checkDue()
    this.timer = setTimeout(() => {
      void this.checkDue()
      this.timer = setInterval(tick, TICK_MS)
    }, 2 * 60 * 1000)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Check prospects whose interval has elapsed since last check. */
  async checkDue(): Promise<CheckResult[]> {
    if (this.running) return []
    const store = this.deps.getStore()
    const now = Date.now()
    const due = store.list().filter((p) => {
      if (p.status !== 'ok') return false
      if (!p.lastCheck) return true  // never checked → due
      const intervalMs = (p.intervalMinutes || 60) * 60 * 1000
      return now - new Date(p.lastCheck).getTime() >= intervalMs
    })
    if (due.length === 0) return []
    // perf/stagger-checks: oldest-first — never-checked first, then oldest
    // lastCheck first. Fair rotation: skipped prospects stay oldest next tick.
    due.sort((a, b) => {
      if (!a.lastCheck && !b.lastCheck) return 0
      if (!a.lastCheck) return -1
      if (!b.lastCheck) return 1
      return new Date(a.lastCheck).getTime() - new Date(b.lastCheck).getTime()
    })
    // perf/stagger-checks: cap the batch — rest stay due for the next tick.
    const batch = due.slice(0, MAX_PER_TICK)
    log(`checkDue: ${due.length} prospect(s) due, checking ${batch.length} this tick (oldest first, ${GAP_MS / 1000}s gap)`)
    this.running = true
    const results: CheckResult[] = []
    try {
      for (let i = 0; i < batch.length; i++) {
        if (i > 0) await sleep(GAP_MS)
        const r = await this.doCheckOne(batch[i].id)
        if (r) results.push(r)
      }
    } finally {
      this.running = false
    }
    this.deps.onCheckDone?.(results)
    return results
  }

  /** Manual trigger (UI "Check now") — checks all, regardless of interval. */
  async checkAll(): Promise<CheckResult[]> {
    if (this.running) return []
    this.running = true
    const results: CheckResult[] = []
    try {
      const store = this.deps.getStore()
      const prospects = store.list().filter((p) => p.status === 'ok')
      log(`checkAll: ${prospects.length} prospect(s) to check`)
      for (const p of prospects) {
        const r = await this.doCheckOne(p.id)
        if (r) results.push(r)
      }
    } finally {
      this.running = false
    }
    this.deps.onCheckDone?.(results)
    return results
  }

  /** Check a single prospect (per-prospect "Check" button). Skips if a check is already running. */
  async checkOne(prospectId: string): Promise<CheckResult | null> {
    if (this.running) {
      log(`checkOne ${prospectId}: skipped (another check running)`)
      return null
    }
    this.running = true
    try {
      return await this.doCheckOne(prospectId)
    } finally {
      this.running = false
    }
  }

  /** Internal single-prospect check (lock must be held by caller). */
  private async doCheckOne(prospectId: string): Promise<CheckResult | null> {
    const store = this.deps.getStore()
    const p = store.get(prospectId)
    if (!p) return null
    log(`checking "${p.name}" (${p.links.length} link(s))`)
    try {
      const r = await this.checkProspect(p)
      log(`"${p.name}": ${r.newItems} new, ${r.queued} queued${r.error ? ` (warnings: ${r.error})` : ''}`)
      store.recordCheck(p.id, true, undefined, r.error)
      return r
    } catch (e) {
      const msg = cleanError((e as Error).message)
      log(`"${p.name}" FAILED: ${msg}`)
      store.recordCheck(p.id, false, msg)
      return { prospectId: p.id, prospectName: p.name, newItems: 0, queued: 0, error: msg }
    }
  }

  private async checkProspect(p: Prospect): Promise<CheckResult> {
    const tools = await this.deps.getTools()
    if (!tools.ytdlp && !tools.gallerydl) throw new Error('No download engine found')
    const seen = this.deps.getSeen()
    const queue = this.deps.getQueue()
    let maxNew = this.deps.getMaxNew()
    // First check of a new prospect: only grab the latest few (don't flood the queue
    // with history). Subsequent checks use the configured maxNew.
    const isFirstCheck = !p.lastCheck
    if (isFirstCheck) {
      // Instagram: max 3 pinned posts (always on top, can't detect them),
      // so use 6 to capture 3 pinned + 3 real latest. Pinned get marked seen
      // on first check, so they won't re-download.
      const hasInstagram = p.links.some(l => l.platform === 'instagram')
      const firstLimit = hasInstagram ? 6 : 3
      maxNew = Math.min(maxNew, firstLimit)
      log(`"${p.name}": first check — limiting to ${maxNew} latest items`)
    }
    const outDir = path.join(this.deps.getDownloadDir(), 'prospects', p.folder)

    // Items already in the queue (not yet downloaded) — don't queue twice.
    // (seen is marked on completion, so a re-check before completion would
    // otherwise duplicate everything.)
    const queuedIds = new Set<string>()
    try {
      for (const t of queue.list()) {
        if (t.prospectId === p.id && t.prospectItemId) queuedIds.add(t.prospectItemId)
      }
    } catch { /* ignore */ }

    let queuedCount = 0
    const linkErrors: string[] = []
    const linkResults: { linkId: string; platform: string; ok: boolean; error?: string }[] = []

    for (const link of p.links) {
      // Skip paused links (auto-paused after 3 fails, or manually paused)
      if (link.linkStatus === 'paused') {
        log(`"${p.name}": skipping paused link (${link.platform})`)
        continue
      }
      // Per-link limit (Rao 2026-10-18): each platform gets its own quota.
      // (Old bug: per-prospect limit broke the loop after first link filled it.)
      let linkNewCount = 0
      const linkMaxNew = maxNew
      try {
        const cookiesFile = this.deps.getCookiesFile(link.platform)
        const proxyUrl = this.deps.getProxyUrl(link.url)
        // Phase 1b rule: yt-dlp → gallery-dl → error (catches image posts)
        // For snapchat/instagram/x, gallery-dl is tried first (better extractors).
        const items = await listWithFallback(tools, link.url, link.platform, Math.max(maxNew, 30), cookiesFile, proxyUrl)

        // X/Twitter: sort by date (newest first) — gallery-dl doesn't guarantee
        // chronological order, and we want the LATEST posts, not random ones.
        if (link.platform === 'x') {
          items.sort((a, b) => {
            const da = a.date || ''
            const db = b.date || ''
            // Tweet IDs are chronological (Snowflake) — higher = newer.
            // Fall back to date string comparison.
            const ida = a.id.replace('x_', '')
            const idb = b.id.replace('x_', '')
            if (/^\d+$/.test(ida) && /^\d+$/.test(idb)) {
              return idb.localeCompare(ida, undefined, { numeric: true })
            }
            return db.localeCompare(da)
          })
          log(`x: sorted ${items.length} items by date (newest first)`)
        }

        for (const item of items) {
          const alreadySeen = seen.has(p.id, item.id)
          const alreadyQueued = queuedIds.has(item.id)
          if (alreadySeen || alreadyQueued) {
            if (alreadySeen) log(`skip (seen): ${item.id}`)
            continue
          }
          // Instagram pinned posts: skip download (they're always on top),
          // but mark as seen so they're not re-scanned every time.
          if (item.isPinned) {
            log(`skipping pinned post: ${item.id}`)
            seen.mark(p.id, item.id)
            continue
          }
          // Snapchat stories expire in 24h — download ALL, bypass maxNew.
          // Spotlight/highlights follow the normal maxNew limit.
          const isSnapStory = link.platform === 'snapchat' && item.isStory
          if (isSnapStory || linkNewCount < linkMaxNew) {
            if (!isSnapStory) linkNewCount++
            queuedIds.add(item.id)  // prevent dupes within this check too
            // Mark seen IMMEDIATELY on queue (standing rule: deleted files never
            // re-download). If the download fails, onFinished unmarks it for retry.
            seen.mark(p.id, item.id)
            // queue the download
            queue.add(item.url, p.quality, { scope: 'single', maxItems: 50, order: 'latest', content: 'all' }, {
              outDir,
              prospectId: p.id,
              prospectItemId: item.id
            })
            queuedCount++
            if (isSnapStory) log(`snapchat story queued (bypasses limit): ${item.title.slice(0, 40)}`)
          } else if (isFirstCheck) {
            // First check: establish baseline — mark older history as seen
            // so future checks only pick up truly NEW content.
            seen.mark(p.id, item.id)
          }
        }
        // Link succeeded — record OK status
        this.deps.getStore().recordLinkCheck(p.id, link.id, true)
        linkResults.push({ linkId: link.id, platform: link.platform, ok: true })
      } catch (e) {
        // one bad link must not kill the whole prospect — record and continue
        const errMsg = cleanError((e as Error).message)
        const fix = suggestFix(errMsg)
        const fullErr = fix ? `${link.platform}: ${errMsg} → ${fix}` : `${link.platform}: ${errMsg}`
        linkErrors.push(fullErr)
        // Per-link fail tracking (3 fails → auto-pause THE LINK)
        this.deps.getStore().recordLinkCheck(p.id, link.id, false, errMsg)
        linkResults.push({ linkId: link.id, platform: link.platform, ok: false, error: errMsg })
        log(`"${p.name}": link ${link.platform} failed: ${errMsg}`)
      }
    }

    // OK if at least one link worked; error only if ALL links failed
    const totalNew = linkResults.filter(r => r.ok).length
    if (linkErrors.length > 0 && queuedCount === 0) {
      // check if any link actually succeeded (vs all failed)
      const anySucceeded = linkResults.some(r => r.ok)
      if (!anySucceeded) {
        throw new Error(linkErrors.join(' | '))
      }
    }

    return {
      prospectId: p.id,
      prospectName: p.name,
      newItems: queuedCount,
      queued: queuedCount,
      ...(linkErrors.length > 0 ? { error: linkErrors.join(' | ') } : {})
    }
  }
}

/**
 * Clean up raw exec errors: strip the command line, keep the meaningful
 * ERROR line (e.g. "ERROR: [instagram:user] ...: Unable to extract data").
 * For gallery-dl (which doesn't use "ERROR:" prefix), keep the last
 * meaningful lines.
 */

/**
 * Suggest a solution for common listing errors (Rao 2026-10-18).
 * Shown in UI so user knows what to do (add proxy, add cookies, etc.)
 */
export function suggestFix(error: string): string {
  const e = error.toLowerCase()
  if (e.includes('secondary user id')) {
    return 'TikTok API issue. Try: 1) Add TikTok cookies in Settings, 2) Enable Smart Mode proxy for TikTok.'
  }
  if (e.includes('enotfound') || e.includes('getaddrinfo') || e.includes('dns')) {
    return 'DNS/network issue. Try: Enable Smart Mode and add a proxy for this platform.'
  }
  if (e.includes('403') || e.includes('forbidden')) {
    return 'Bot-block (403). Try: 1) Add a proxy in Smart Mode, 2) Add cookies for this platform.'
  }
  if (e.includes('login') || e.includes('unauthorized') || e.includes('401')) {
    return 'Login required. Add cookies for this platform in Settings → Cookie Profiles.'
  }
  if (e.includes('unsupported url')) {
    return 'URL format not supported. Check if the profile URL is correct.'
  }
  if (e.includes('private') || e.includes('not found') || e.includes('404')) {
    return 'Profile not found or private. Check the URL, or add cookies if it\'s private.'
  }
  if (e.includes('rate limit') || e.includes('429')) {
    return 'Rate limited. Wait a bit, or enable Smart Mode proxy.'
  }
  return ''
}

export function cleanError(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  // find the last ERROR: line (yt-dlp puts it at the end)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/ERROR:\s*(.+)/)
    if (m) {
      let msg = m[1].trim()
      // strip "please report this issue…" boilerplate
      msg = msg.replace(/;?\s*please report this issue on.*$/i, '').trim()
      return msg || 'Unknown error'
    }
  }
  // gallery-dl style: look for [extractor][error] or traceback tail
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // skip the "Command failed: ..." header line
    if (/^command failed:/i.test(line)) continue
    // gallery-dl error markers
    if (/\[(error|warning)\]/i.test(line) || /error/i.test(line)) {
      // strip long paths, keep it readable
      let msg = line.replace(/[A-Z]:\\[^\s:]*/g, '<path>').replace(/\/[^\s:]*\/[^\s:]*/g, '<path>')
      return msg.length > 200 ? msg.slice(0, 200) + '…' : msg
    }
  }
  // fallback: last non-empty line (not the command), truncated
  const meaningful = lines.filter((l) => !/^command failed:/i.test(l))
  const last = meaningful[meaningful.length - 1] || lines[0] || 'Unknown error'
  return last.length > 200 ? last.slice(0, 200) + '…' : last
}
