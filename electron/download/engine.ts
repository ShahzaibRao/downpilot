import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export type Quality = 'best' | '4k' | '1080p' | '720p' | '480p'

/**
 * Kill a job's whole process tree.
 *
 * A plain proc.kill() only stops the direct child. During the merge step
 * yt-dlp runs ffmpeg as a child process — killing just yt-dlp leaves
 * ffmpeg alive, which finishes the merge in the background. That's the
 * "paused but the video still arrived" bug.
 */
function killTree(proc: ChildProcess | null): void {
  if (!proc || !proc.pid) {
    console.log('[killTree] no process to kill (already gone)')
    return
  }
  const pid = proc.pid
  console.log(`[killTree] killing process tree, pid=${pid}`)
  if (process.platform === 'win32') {
    // taskkill FIRST: /T kills the whole tree (yt-dlp + its ffmpeg child).
    // It must run before proc.kill() — once the parent is dead, taskkill
    // can't find the pid and the children survive (that's the bug this
    // ordering fixes).
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (err) => {
      if (err) {
        console.log(`[killTree] taskkill FAILED: ${err.message} — falling back to proc.kill()`)
        try {
          proc.kill()
        } catch {
          /* already dead */
        }
      } else {
        console.log(`[killTree] taskkill OK (pid=${pid})`)
      }
    })
  } else {
    try {
      proc.kill()
    } catch {
      /* already dead */
    }
    try {
      process.kill(-pid, 'SIGKILL') // whole process group (needs detached: true at spawn)
      console.log(`[killTree] process group SIGKILL sent (pid=${pid})`)
    } catch {
      console.log(`[killTree] process group already gone (pid=${pid})`)
    }
  }
}

export type Scope = 'single' | 'playlist' | 'channel'
export type Order = 'latest' | 'oldest' | 'popular'

export interface ScopeOpts {
  scope: Scope
  /** Max items for playlist/channel (default 50). */
  maxItems: number
  order: Order
}

export function defaultScopeOpts(): ScopeOpts {
  return { scope: 'single', maxItems: 50, order: 'latest' }
}

export interface DownloadOptions {
  url: string
  outDir: string
  quality: Quality
  ytdlpPath: string
  /** Directory containing ffmpeg/ffprobe (yt-dlp wants a dir, not the exe). */
  ffmpegDir: string
  scopeOpts: ScopeOpts
  /** Resolved playlist indices for order='popular' (two-pass). */
  playlistItems?: number[]
}

export type DlStatus = 'downloading' | 'merging' | 'done' | 'error'

export interface ProgressEvent {
  id: string
  status: DlStatus
  percent: number
  downloaded: number
  total: number | null
  speed: string
  eta: string
  filename: string
  /** Which engine produced this event: 'yt-dlp' | 'gallery' | '' (not yet known). */
  engine: string
  error?: string
}

/** yt-dlp format selectors per quality choice. */
export const QUALITY_FORMATS: Record<Quality, string> = {
  best: 'bv*+ba/b',
  '4k': 'bv*[height<=2160]+ba/b[height<=2160]/b',
  '1080p': 'bv*[height<=1080]+ba/b[height<=1080]/b',
  '720p': 'bv*[height<=720]+ba/b[height<=720]/b',
  '480p': 'bv*[height<=480]+ba/b[height<=480]/b'
}

/**
 * One yt-dlp download job. Progress comes from a machine-readable
 * --progress-template line; merging/destination are parsed from the
 * human-readable lines.
 */
export class YtDlpJob {
  private proc: ChildProcess | null = null
  private filename = ''
  private finished = false

  constructor(
    readonly id: string,
    private opts: DownloadOptions,
    private onEvent: (e: ProgressEvent) => void
  ) {}

  start(): void {
    const outTemplate = path.join(this.opts.outDir, '%(title).200B [%(id)s].%(ext)s')
    const args = [
      '-f',
      QUALITY_FORMATS[this.opts.quality],
      '--merge-output-format',
      'mp4',
      '--ffmpeg-location',
      this.opts.ffmpegDir,
      '--newline',
      '--progress-template',
      '[dpdl]%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed_str)s|%(progress.eta_str)s',
      '-o',
      outTemplate,
      ...this.scopeArgs(),
      this.opts.url
    ]

    this.proc = spawn(this.opts.ytdlpPath, args, {
      windowsHide: true,
      // Own process group on POSIX so killTree() can take the whole tree (incl. ffmpeg).
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let buf = ''
    let stderrTail = ''
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) this.handleLine(line.trim())
    })
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000)
    })
    this.proc.on('error', (err) => {
      if (this.finished) return
      this.finished = true
      this.emit({ status: 'error', error: `failed to start yt-dlp: ${err.message}` })
    })
    this.proc.on('close', (code) => {
      if (this.finished) return
      this.finished = true
      if (code === 0) {
        this.emit({ status: 'done', percent: 100 })
      } else {
        const reason = stderrTail.split('\n').filter((l) => l.includes('ERROR')).pop() ?? `yt-dlp exited with code ${code}`
        this.emit({ status: 'error', error: reason })
      }
    })
  }

  cancel(): void {
    killTree(this.proc)
  }

  /** Playlist/channel scope → yt-dlp playlist flags. */
  private scopeArgs(): string[] {
    const { scope, maxItems, order, playlistItems } = {
      ...this.opts.scopeOpts,
      playlistItems: this.opts.playlistItems
    }
    if (scope === 'single') return ['--no-playlist']
    const args = ['--yes-playlist']
    if (order === 'popular' && playlistItems && playlistItems.length > 0) {
      // two-pass already resolved the most-viewed indices
      args.push('--playlist-items', playlistItems.join(','))
    } else {
      args.push('--playlist-end', String(Math.max(1, maxItems)))
      if (order === 'oldest') args.push('--playlist-reverse')
    }
    return args
  }

  private handleLine(line: string): void {
    if (line.startsWith('[dpdl]')) {
      const parts = line.slice(6).split('|')
      if (parts.length < 5) return
      const percent = parseFloat(parts[0].replace('%', '').trim())
      const downloaded = numOrNull(parts[1])
      const total = numOrNull(parts[2])
      this.emit({
        status: 'downloading',
        percent: Number.isFinite(percent) ? percent : 0,
        downloaded: downloaded ?? 0,
        total,
        speed: parts[3] === 'NA' ? '' : parts[3],
        eta: parts[4] === 'NA' ? '' : parts[4]
      })
    } else if (line.startsWith('[Merger]')) {
      const m = line.match(/Merging formats into "(.+)"/)
      if (m) this.filename = path.basename(m[1])
      this.emit({ status: 'merging', percent: 100 })
    } else if (line.startsWith('[download] Destination:')) {
      this.filename = path.basename(line.slice('[download] Destination:'.length).trim())
    }
  }

  private emit(partial: Partial<ProgressEvent>): void {
    this.onEvent({
      id: this.id,
      status: 'downloading',
      percent: 0,
      downloaded: 0,
      total: null,
      speed: '',
      eta: '',
      filename: this.filename,
      engine: '', // filled in by the DownloadJob orchestrator
      ...partial
    })
  }
}

function numOrNull(s: string): number | null {
  if (s === 'NA') return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// gallery-dl engine
// ---------------------------------------------------------------------------

export interface GalleryDlOptions {
  url: string
  outDir: string
  gallerydlPath: string
  /** Bound on files per job (safety for profile/album URLs). */
  maxItems: number
}

/**
 * gallery-dl job. When stdout is piped (our case), gallery-dl prints one
 * downloaded file path per line (PipeOutput.success) and "# <path>" for
 * skipped files — that's our progress signal. Per-byte progress isn't
 * available this way, so percent stays -1 (UI shows an indeterminate bar).
 */
export class GalleryDlJob {
  private proc: ChildProcess | null = null
  private files = 0
  private finished = false

  constructor(
    readonly id: string,
    private opts: GalleryDlOptions,
    private onEvent: (e: ProgressEvent) => void
  ) {}

  start(): void {
    const args = [
      '-d',
      this.opts.outDir,
      '--range',
      `1-${Math.max(1, this.opts.maxItems)}`,
      this.opts.url
    ]
    this.proc = spawn(this.opts.gallerydlPath, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let buf = ''
    let stderrTail = ''
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        if (t.startsWith('# ')) continue // skipped file
        this.files++
        this.emit({ status: 'downloading', filename: path.basename(t) })
      }
    })
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000)
    })
    this.proc.on('error', (err) => {
      if (this.finished) return
      this.finished = true
      this.emit({ status: 'error', error: `failed to start gallery-dl: ${err.message}` })
    })
    this.proc.on('close', (code) => {
      if (this.finished) return
      this.finished = true
      if (code === 0) {
        if (this.files === 0) {
          this.emit({ status: 'error', error: 'gallery-dl finished without downloading any file' })
        } else {
          this.emit({ status: 'done', percent: 100 })
        }
      } else {
        const reason =
          stderrTail
            .split('\n')
            .filter((l) => /\[error\]|error:/i.test(l))
            .pop()?.trim() ?? `gallery-dl exited with code ${code}`
        this.emit({ status: 'error', error: reason })
      }
    })
  }

  cancel(): void {
    killTree(this.proc)
  }

  private emit(partial: Partial<ProgressEvent>): void {
    this.onEvent({
      id: this.id,
      status: 'downloading',
      percent: -1, // indeterminate
      downloaded: 0,
      total: null,
      speed: '',
      eta: '',
      filename: '',
      engine: '', // filled in by the DownloadJob orchestrator
      ...partial
    })
  }
}

// ---------------------------------------------------------------------------
// Orchestrator: router + fallback chain
// ---------------------------------------------------------------------------

import { routeUrl, engineLabel, type Engine } from './router'

export interface Tools {
  ytdlp?: string
  ffmpegDir?: string
  gallerydl?: string
}

function blankEvent(id: string): ProgressEvent {
  return {
    id,
    status: 'downloading',
    percent: 0,
    downloaded: 0,
    total: null,
    speed: '',
    eta: '',
    filename: '',
    engine: ''
  }
}

/**
 * Two-pass "popular" ordering: flat-dump the playlist/channel (up to 200
 * items — fast, no downloads), sort by view count, return the playlist
 * indices of the top `limit`. The caller passes them as --playlist-items.
 * Returns undefined when the dump fails → caller falls back to latest.
 */
export async function resolvePopularIndices(
  ytdlpPath: string,
  url: string,
  limit: number
): Promise<number[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      ytdlpPath,
      [
        '--flat-playlist',
        '--no-warnings',
        '--print',
        '%(playlist_index)s|%(view_count)s',
        '--playlist-end',
        '200',
        url
      ],
      { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
    )
    const items = stdout
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\|(\d+|NA|None)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({
        index: parseInt(m[1], 10),
        views: m[2] === 'NA' || m[2] === 'None' ? 0 : parseInt(m[2], 10)
      }))
    if (items.length === 0) return undefined
    items.sort((a, b) => b.views - a.views)
    return items.slice(0, Math.max(1, limit)).map((i) => i.index)
  } catch {
    return undefined
  }
}

/**
 * One logical download: picks the primary engine from the URL, runs it,
 * and falls back to the secondary engine on failure. If both fail, the
 * error carries both reasons (CreatorWatch rule).
 */
export class DownloadJob {
  private current: { cancel(): void } | null = null
  private errors: string[] = []
  private cancelled = false

  constructor(
    readonly id: string,
    private url: string,
    private outDir: string,
    private quality: Quality,
    private tools: Tools,
    private onEvent: (e: ProgressEvent) => void,
    private scopeOpts: ScopeOpts = defaultScopeOpts()
  ) {}

  start(): void {
    const route = routeUrl(this.url)
    this.tryEngine(route.primary, () => this.tryEngine(route.secondary, () => this.failAll()))
  }

  cancel(): void {
    this.cancelled = true
    this.current?.cancel()
  }

  private async tryEngine(engine: Engine, next: () => void): Promise<void> {
    if (this.cancelled) return
    const label = engineLabel(engine)
    const bin = engine === 'ytdlp' ? this.tools.ytdlp : this.tools.gallerydl
    if (!bin) {
      this.errors.push(`${label} is not installed — get it from Settings`)
      next()
      return
    }
    // Announce which engine is trying (UI badge switches on fallback too).
    this.onEvent({ ...blankEvent(this.id), engine: label })

    const sink = (e: ProgressEvent) => {
      if (e.status === 'error') {
        this.errors.push(`${label}: ${e.error ?? 'unknown error'}`)
        next()
      } else {
        this.onEvent({ ...e, engine: label })
      }
    }

    if (engine === 'ytdlp') {
      if (!this.tools.ffmpegDir) {
        this.errors.push('yt-dlp: ffmpeg is not installed — get it from Settings')
        next()
        return
      }
      // Popular order needs the two-pass: resolve indices first.
      let playlistItems: number[] | undefined
      if (this.scopeOpts.scope !== 'single' && this.scopeOpts.order === 'popular') {
        this.onEvent({ ...blankEvent(this.id), engine: label, filename: 'Finding most popular videos…' })
        playlistItems = await resolvePopularIndices(bin, this.url, this.scopeOpts.maxItems)
        if (this.cancelled) return
        if (!playlistItems) {
          // dump failed → fall back to latest order rather than erroring
          this.scopeOpts = { ...this.scopeOpts, order: 'latest' }
        }
      }
      const job = new YtDlpJob(
        this.id,
        {
          url: this.url,
          outDir: this.outDir,
          quality: this.quality,
          ytdlpPath: bin,
          ffmpegDir: this.tools.ffmpegDir,
          scopeOpts: this.scopeOpts,
          playlistItems
        },
        sink
      )
      this.current = job
      job.start()
    } else {
      const job = new GalleryDlJob(
        this.id,
        { url: this.url, outDir: this.outDir, gallerydlPath: bin, maxItems: this.scopeOpts.maxItems },
        sink
      )
      this.current = job
      job.start()
    }
  }

  private failAll(): void {
    if (this.cancelled) return
    this.onEvent({
      ...blankEvent(this.id),
      status: 'error',
      error: this.errors.join('  |  ')
    })
  }
}
