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

  // ---- downloads: queue (Phase 1c) ----
  /** Add a URL to the download queue. Returns the task. */
  queueAdd: (opts: { url: string; quality: string }) => ipcRenderer.invoke('queue:add', opts),

  /** List all tasks (also used to hydrate the UI on load). */
  queueList: () => ipcRenderer.invoke('queue:list'),

  queuePause: (id: string) => ipcRenderer.invoke('queue:pause', id),
  queueResume: (id: string) => ipcRenderer.invoke('queue:resume', id),
  queueRetry: (id: string) => ipcRenderer.invoke('queue:retry', id),
  queueCancel: (id: string) => ipcRenderer.invoke('queue:cancel', id),
  queueClearDone: () => ipcRenderer.invoke('queue:clearDone'),

  /** Subscribe to queue updates (full task list on every change). Returns an unsubscribe function. */
  onQueueUpdate: (cb: (tasks: Record<string, unknown>[]) => void) => {
    const handler = (_event: unknown, tasks: Record<string, unknown>[]) => cb(tasks)
    ipcRenderer.on('queue:update', handler)
    return () => ipcRenderer.removeListener('queue:update', handler)
  },

  // ---- settings ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  pickDownloadDir: () => ipcRenderer.invoke('dialog:openDir')
})
