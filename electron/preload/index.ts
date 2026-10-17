import { contextBridge, ipcRenderer } from 'electron'

/**
 * Renderer-facing API. Everything goes through here — the renderer
 * never touches node/Electron directly (contextIsolation stays on).
 */
contextBridge.exposeInMainWorld('dpApi', {
  // ---- dependencies (Phase 0) ----
  /** Full dependency status from the Go sidecar (dp-deps detect --json). */
  getDepsStatus: () => ipcRenderer.invoke('deps:status'),

  /**
   * Download deps via the sidecar. Resolves when done; progress arrives
   * through onDepsProgress as NDJSON events ({event, tool, downloaded, total...}).
   */
  fetchDeps: (only?: string[]) => ipcRenderer.invoke('deps:fetch', only),

  /** Subscribe to sidecar progress events. Returns an unsubscribe function. */
  onDepsProgress: (cb: (evt: Record<string, unknown>) => void) => {
    const handler = (_event: unknown, evt: Record<string, unknown>) => cb(evt)
    ipcRenderer.on('deps:progress', handler)
    return () => ipcRenderer.removeListener('deps:progress', handler)
  },

  // ---- downloads (Phase 1) ----
  /** Start a download. Returns the job id; progress streams via onDownloadProgress. */
  startDownload: (opts: { url: string; quality: string }) => ipcRenderer.invoke('dl:start', opts),

  /** Cancel a running download. */
  cancelDownload: (id: string) => ipcRenderer.invoke('dl:cancel', id),

  /** Subscribe to download progress events. Returns an unsubscribe function. */
  onDownloadProgress: (cb: (evt: Record<string, unknown>) => void) => {
    const handler = (_event: unknown, evt: Record<string, unknown>) => cb(evt)
    ipcRenderer.on('dl:progress', handler)
    return () => ipcRenderer.removeListener('dl:progress', handler)
  },

  // ---- settings ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  pickDownloadDir: () => ipcRenderer.invoke('dialog:openDir')
})
