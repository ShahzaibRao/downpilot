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

/** window.dpApi — exposed by electron/preload/index.ts */
export interface DpApi {
  getDepsStatus(): Promise<DepsStatus>
  fetchDeps(only?: string[]): Promise<boolean>
  onDepsProgress(cb: (evt: DepsProgressEvent) => void): () => void
}

declare global {
  interface Window {
    dpApi: DpApi
  }
}
