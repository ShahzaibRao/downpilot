import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

export type Quality = 'best' | '4k' | '1080p' | '720p' | '480p'

export interface DownloadOptions {
  url: string
  outDir: string
  quality: Quality
  ytdlpPath: string
  /** Directory containing ffmpeg/ffprobe (yt-dlp wants a dir, not the exe). */
  ffmpegDir: string
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

  constructor(
    readonly id: string,
    private opts: DownloadOptions,
    private onEvent: (e: ProgressEvent) => void
  ) {}

  start(): void {
    const outTemplate = path.join(this.opts.outDir, '%(title).200B [%(id)s].%(ext)s')
    const args = [
      '--no-playlist',
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
      this.opts.url
    ]

    this.proc = spawn(this.opts.ytdlpPath, args, {
      windowsHide: true,
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
      this.emit({ status: 'error', error: `failed to start yt-dlp: ${err.message}` })
    })
    this.proc.on('close', (code) => {
      if (code === 0) {
        this.emit({ status: 'done', percent: 100 })
      } else {
        const reason = stderrTail.split('\n').filter((l) => l.includes('ERROR')).pop() ?? `yt-dlp exited with code ${code}`
        this.emit({ status: 'error', error: reason })
      }
    })
  }

  cancel(): void {
    this.proc?.kill()
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
      ...partial
    })
  }
}

function numOrNull(s: string): number | null {
  if (s === 'NA') return null
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}
