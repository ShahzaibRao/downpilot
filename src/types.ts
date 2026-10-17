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

export type Scope = 'single' | 'playlist' | 'channel'
export type Order = 'latest' | 'oldest' | 'popular'
/** YouTube channel content filter (ignored for non-YouTube URLs). */
export type ContentFilter = 'all' | 'videos' | 'shorts'

export interface ScopeOpts {
  scope: Scope
  maxItems: number
  order: Order
  content: ContentFilter
}

export interface QueueTask extends ScopeOpts {
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

export interface HistoryEntry {
  id: string
  url: string
  filename: string
  engine: string
  quality: Quality
  status: 'done' | 'failed'
  error?: string
  downloaded: number
  completedAt: number
}

export interface CookieProfileMeta {
  platform: string
  addedAt: number
  expired: boolean
  lastTestedAt?: number
  lastTestOk?: boolean
}

export interface ProxyConfig {
  host: string
  port: number
  username: string
  password: string
}

export interface SmartModeConfig {
  enabled: boolean
  proxy: ProxyConfig
  platforms: string[]
}

export interface ProxyTestResult {
  ok: boolean
  ip?: string
  status?: number
  error?: string
}

export interface Settings {
  downloadDir: string
  maxConcurrent: number
  smartMode: SmartModeConfig
}

/** window.dpApi — exposed by electron/preload/index.ts */
export interface DpApi {
  getDepsStatus(): Promise<DepsStatus>
  fetchDeps(only?: string[]): Promise<boolean>
  onDepsProgress(cb: (evt: DepsProgressEvent) => void): () => void
  queueAdd(opts: { url: string; quality: Quality; scopeOpts?: ScopeOpts }): Promise<QueueTask>
  queueList(): Promise<QueueTask[]>
  queuePause(id: string): Promise<boolean>
  queueResume(id: string): Promise<boolean>
  queueRetry(id: string): Promise<boolean>
  queueCancel(id: string): Promise<boolean>
  queueClearDone(): Promise<boolean>
  queueAddBulk(items: { url: string; quality: Quality; scopeOpts?: ScopeOpts }[]): Promise<{ added: number; skipped: number }>
  onQueueUpdate(cb: (tasks: QueueTask[]) => void): () => void
  historyList(): Promise<HistoryEntry[]>
  historyClear(): Promise<boolean>
  onHistoryUpdate(cb: (entries: HistoryEntry[]) => void): () => void
  cookiesList(): Promise<CookieProfileMeta[]>
  cookiesAdd(opts: { platform: string; content: string }): Promise<CookieProfileMeta>
  cookiesRemove(platform: string): Promise<boolean>
  cookiesTest(opts: { platform: string; testUrl: string }): Promise<{ ok: boolean }>
  onCookiesUpdate(cb: (metas: CookieProfileMeta[]) => void): () => void
  proxyTest(): Promise<ProxyTestResult>
  proxyTestSite(siteUrl: string): Promise<ProxyTestResult>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  pickDownloadDir(): Promise<string | null>
}

declare global {
  interface Window {
    dpApi: DpApi
  }
}
