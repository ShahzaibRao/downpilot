import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
}

export interface CheckResult {
  prospectId: string
  prospectName: string
  newItems: number
  queued: number
  error?: string
}

/** 60 minutes between auto-checks. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000
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
 * Fallback listing via gallery-dl (Phase 1b rule: yt-dlp → gallery-dl → error).
 * Uses --dump-json; parses extractor-specific IDs into post URLs.
 * This is what catches image posts on Instagram/X/Snapchat that yt-dlp
 * can't list or download.
 */
export async function listItemsGalleryDl(
  gdlPath: string,
  url: string,
  platform: string,
  limit: number,
  cookiesFile?: string | null,
  proxyUrl?: string | null
): Promise<ProspectItem[]> {
  const args = [
    '--dump-json',
    '--no-download',
    '--range', `1-${limit}`,
    '--no-check-certificates',
    url
  ]
  if (cookiesFile) args.push('--cookies', cookiesFile)
  if (proxyUrl) args.push('--proxy', proxyUrl)

  const { stdout } = await execFileAsync(gdlPath, args, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  })

  const username = extractUsername(url)
  const items: ProspectItem[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed)
      const parsed = parseGalleryItem(obj, platform, username)
      if (parsed) items.push(parsed)
    } catch {
      /* skip malformed JSON lines */
    }
  }
  return items.slice(0, limit)
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
export function parseGalleryItem(obj: any, platform: string, username: string): ProspectItem | null {
  const str = (v: any) => (v == null ? '' : String(v))
  if (platform === 'instagram') {
    const shortcode = str(obj.shortcode)
    if (!shortcode) return null
    return {
      id: `ig_${shortcode}`,
      title: str(obj.title || obj.caption || shortcode).slice(0, 100),
      url: `https://www.instagram.com/p/${shortcode}/`
    }
  }
  if (platform === 'tiktok') {
    const id = str(obj.id)
    if (!id) return null
    return {
      id: `tt_${id}`,
      title: str(obj.title || obj.desc || id).slice(0, 100),
      url: username
        ? `https://www.tiktok.com/@${username}/video/${id}`
        : `https://www.tiktok.com/video/${id}`
    }
  }
  if (platform === 'x') {
    const id = str(obj.tweet_id || obj.id)
    if (!id) return null
    return {
      id: `x_${id}`,
      title: str(obj.content || obj.title || id).slice(0, 100),
      url: `https://x.com/i/status/${id}`
    }
  }
  if (platform === 'snapchat') {
    const id = str(obj.id || obj.snap_id)
    if (!id) return null
    return {
      id: `sc_${id}`,
      title: str(obj.title || id).slice(0, 100),
      url: str(obj.webpage_url)
    }
  }
  // generic fallback
  const id = str(obj.id || obj.post_id)
  if (!id) return null
  return {
    id: `${platform}_${id}`,
    title: str(obj.title || id).slice(0, 100),
    url: str(obj.webpage_url)
  }
}

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
  let ytdlpErr: Error | null = null
  if (tools.ytdlp) {
    log(`listing ${platform} via yt-dlp: ${url}`)
    try {
      const items = await listItems(tools.ytdlp, url, limit, cookiesFile, proxyUrl)
      log(`yt-dlp OK: ${items.length} items`)
      return items
    } catch (e) {
      ytdlpErr = e as Error
      logExecFailure('yt-dlp', e)
    }
  }
  if (tools.gallerydl) {
    log(`listing ${platform} via gallery-dl: ${url}`)
    try {
      const items = await listItemsGalleryDl(tools.gallerydl, url, platform, limit, cookiesFile, proxyUrl)
      log(`gallery-dl OK: ${items.length} items`)
      return items
    } catch (e) {
      logExecFailure('gallery-dl', e)
      const gdlMsg = cleanError((e as Error).message)
      const ytdlpMsg = ytdlpErr ? cleanError(ytdlpErr.message) : 'yt-dlp not available'
      throw new Error(`${platform}: yt-dlp: ${ytdlpMsg} | gallery-dl: ${gdlMsg}`)
    }
  }
  throw ytdlpErr ?? new Error('No listing engine available')
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
    // first check 2 min after start (let the app settle), then every 60 min
    this.timer = setTimeout(() => {
      void this.checkAll()
      this.timer = setInterval(() => void this.checkAll(), CHECK_INTERVAL_MS)
    }, 2 * 60 * 1000)
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Manual trigger (UI "Check now"). */
  async checkAll(): Promise<CheckResult[]> {
    if (this.running) return []
    this.running = true
    const results: CheckResult[] = []
    try {
      const store = this.deps.getStore()
      const prospects = store.list().filter((p) => p.status === 'ok')
      log(`checkAll: ${prospects.length} prospect(s) to check`)
      for (const p of prospects) {
        const r = await this.checkOne(p.id)
        if (r) results.push(r)
      }
    } finally {
      this.running = false
    }
    this.deps.onCheckDone?.(results)
    return results
  }

  /** Check a single prospect (per-prospect "Check" button). */
  async checkOne(prospectId: string): Promise<CheckResult | null> {
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
    const maxNew = this.deps.getMaxNew()
    const outDir = path.join(this.deps.getDownloadDir(), 'prospects', p.folder)

    let newCount = 0
    let queuedCount = 0
    const linkErrors: string[] = []

    for (const link of p.links) {
      if (newCount >= maxNew) break
      try {
        const cookiesFile = this.deps.getCookiesFile(link.platform)
        const proxyUrl = this.deps.getProxyUrl(link.url)
        // Phase 1b rule: yt-dlp → gallery-dl → error (catches image posts)
        const items = await listWithFallback(tools, link.url, link.platform, maxNew, cookiesFile, proxyUrl)

        for (const item of items) {
          if (newCount >= maxNew) break
          if (seen.has(p.id, item.id)) continue
          newCount++
          // queue the download; mark seen when it completes (via onFinished)
          queue.add(item.url, 'best', { scope: 'single', maxItems: 50, order: 'latest', content: 'all' }, {
            outDir,
            prospectId: p.id,
            prospectItemId: item.id
          })
          queuedCount++
        }
      } catch (e) {
        // one bad link must not kill the whole prospect — record and continue
        linkErrors.push(`${link.platform}: ${cleanError((e as Error).message)}`)
      }
    }

    // OK if at least one link worked; error only if ALL links failed
    if (linkErrors.length > 0 && newCount === 0 && queuedCount === 0) {
      // check if any link actually succeeded (vs all failed)
      const anySucceeded = p.links.length > linkErrors.length
      if (!anySucceeded) {
        throw new Error(linkErrors.join(' | '))
      }
    }

    return {
      prospectId: p.id,
      prospectName: p.name,
      newItems: newCount,
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
