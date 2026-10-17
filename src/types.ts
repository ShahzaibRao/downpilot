/** One dependency as reported by `dp-deps detect --json`. */
export interface DepResult {
  kind: string
  found: boolean
  optional?: boolean
  path?: string
  version?: string
  source?: string
  reason?: string
  managed?: boolean
  requiredVersion?: string
  stale?: boolean
}

export interface DepsStatus {
  results: DepResult[]
}

/** Sidecar progress event (NDJSON line from dp-deps fetch). */
export interface DepsProgressEvent {
  event: string
  tool?: string
  downloaded?: number
  total?: number
  path?: string
  message?: string
}

export type Quality = 'best' | '4k' | '1080p' | '720p' | '480p'

export type DlStatus = 'downloading' | 'merging' | 'done' | 'error'

export interface DownloadProgress {
  id: string
  status: DlStatus
  percent: number
  downloaded: number
  total: number | null
  speed: string
  eta: string
  filename: string
  /** 'yt-dlp' | 'gallery' | '' (engine not yet chosen). -1 percent = indeterminate. */
  engine: string
  error?: string
}

export interface Settings {
  downloadDir: string
}

/** window.dpApi — exposed by electron/preload/index.ts */
export interface DpApi {
  getDepsStatus(): Promise<DepsStatus>
  fetchDeps(only?: string[]): Promise<boolean>
  onDepsProgress(cb: (evt: DepsProgressEvent) => void): () => void
  startDownload(opts: { url: string; quality: Quality }): Promise<string>
  cancelDownload(id: string): Promise<boolean>
  onDownloadProgress(cb: (evt: DownloadProgress) => void): () => void
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  pickDownloadDir(): Promise<string | null>
}

declare global {
  interface Window {
    dpApi: DpApi
  }
}
