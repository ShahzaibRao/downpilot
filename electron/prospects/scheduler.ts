import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { Prospect } from './store'
import type { ProspectStore } from './store'
import type { SeenStore } from './seen'
import type { QueueManager } from '../download/queue'
import type { Tools } from '../download/engine'

const execFileAsync = promisify(execFile)

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
 * List recent items for a profile/channel URL via yt-dlp flat playlist.
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
      for (const p of prospects) {
        try {
          const r = await this.checkProspect(p)
          results.push(r)
          store.recordCheck(p.id, true)
        } catch (e) {
          const msg = (e as Error).message
          results.push({ prospectId: p.id, prospectName: p.name, newItems: 0, queued: 0, error: msg })
          store.recordCheck(p.id, false, msg)
        }
      }
    } finally {
      this.running = false
    }
    this.deps.onCheckDone?.(results)
    return results
  }

  private async checkProspect(p: Prospect): Promise<CheckResult> {
    const tools = await this.deps.getTools()
    if (!tools.ytdlp) throw new Error('yt-dlp not found')
    const seen = this.deps.getSeen()
    const queue = this.deps.getQueue()
    const maxNew = this.deps.getMaxNew()
    const outDir = path.join(this.deps.getDownloadDir(), 'prospects', p.folder)

    let newCount = 0
    let queuedCount = 0

    for (const link of p.links) {
      if (newCount >= maxNew) break
      const cookiesFile = this.deps.getCookiesFile(link.platform)
      const proxyUrl = this.deps.getProxyUrl(link.url)
      const items = await listItems(tools.ytdlp, link.url, maxNew, cookiesFile, proxyUrl)

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
    }

    return { prospectId: p.id, prospectName: p.name, newItems: newCount, queued: queuedCount }
  }
}
