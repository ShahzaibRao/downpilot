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

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed'

export interface QueueTask {
  id: string
  url: string
  quality: Quality
  status: TaskStatus
  engine: string
  filename: string
  percent: number
  downloaded: number
  total: number | null
  speed: string
  eta: string
  error?: string
  createdAt: number
  updatedAt: number
}

export interface Settings {
  downloadDir: string
  maxConcurrent: number
}

/** window.dpApi — exposed by electron/preload/index.ts */
export interface DpApi {
  getDepsStatus(): Promise<DepsStatus>
  fetchDeps(only?: string[]): Promise<boolean>
  onDepsProgress(cb: (evt: DepsProgressEvent) => void): () => void
  queueAdd(opts: { url: string; quality: Quality }): Promise<QueueTask>
  queueList(): Promise<QueueTask[]>
  queuePause(id: string): Promise<boolean>
  queueResume(id: string): Promise<boolean>
  queueRetry(id: string): Promise<boolean>
  queueCancel(id: string): Promise<boolean>
  queueClearDone(): Promise<boolean>
  onQueueUpdate(cb: (tasks: QueueTask[]) => void): () => void
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  pickDownloadDir(): Promise<string | null>
}

declare global {
  interface Window {
    dpApi: DpApi
  }
}
