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

  /** Add many URLs at once (duplicates auto-skipped). Returns {added, skipped}. */
  queueAddBulk: (items: { url: string; quality: string; scopeOpts?: Record<string, unknown> }[]) =>
    ipcRenderer.invoke('queue:addBulk', items),

  // ---- history (Phase 1d) ----
  historyList: () => ipcRenderer.invoke('history:list'),
  historyClear: () => ipcRenderer.invoke('history:clear'),

  /** Subscribe to history updates. Returns an unsubscribe function. */
  onHistoryUpdate: (cb: (entries: Record<string, unknown>[]) => void) => {
    const handler = (_event: unknown, entries: Record<string, unknown>[]) => cb(entries)
    ipcRenderer.on('history:update', handler)
    return () => ipcRenderer.removeListener('history:update', handler)
  },

  // ---- cookie profiles (Phase 2a) ----
  cookiesList: () => ipcRenderer.invoke('cookies:list'),
  cookiesAdd: (opts: { platform: string; content: string }) => ipcRenderer.invoke('cookies:add', opts),
  cookiesRemove: (platform: string) => ipcRenderer.invoke('cookies:remove', platform),
  cookiesTest: (opts: { platform: string; testUrl: string }) => ipcRenderer.invoke('cookies:test', opts),

  // ---- Smart Mode proxy tests (Phase 2c) ----
  proxyTest: () => ipcRenderer.invoke('proxy:test'),
  proxyTestSite: (siteUrl: string) => ipcRenderer.invoke('proxy:testSite', siteUrl),

  // ---- POT server (Phase 2b status panel) ----
  potStatus: () => ipcRenderer.invoke('pot:status'),
  potStart: () => ipcRenderer.invoke('pot:start'),
  potStop: () => ipcRenderer.invoke('pot:stop'),
  potForceStop: () => ipcRenderer.invoke('pot:forceStop'),
  // prospects (Phase 3)
  prospectsList: () => ipcRenderer.invoke('prospects:list'),
  prospectsAdd: (url: string, name?: string) => ipcRenderer.invoke('prospects:add', url, name),
  prospectsAddLink: (prospectId: string, url: string) => ipcRenderer.invoke('prospects:addLink', prospectId, url),
  prospectsRemoveLink: (prospectId: string, linkId: string) => ipcRenderer.invoke('prospects:removeLink', prospectId, linkId),
  prospectsRemove: (id: string) => ipcRenderer.invoke('prospects:remove', id),
  prospectsRename: (id: string, name: string) => ipcRenderer.invoke('prospects:rename', id, name),
  prospectsSetStatus: (id: string, status: string) => ipcRenderer.invoke('prospects:setStatus', id, status),
  prospectsUnpause: (id: string) => ipcRenderer.invoke('prospects:unpause', id),

  /** Subscribe to cookie profile updates. Returns an unsubscribe function. */
  onCookiesUpdate: (cb: (metas: Record<string, unknown>[]) => void) => {
    const handler = (_event: unknown, metas: Record<string, unknown>[]) => cb(metas)
    ipcRenderer.on('cookies:update', handler)
    return () => ipcRenderer.removeListener('cookies:update', handler)
  },

  // ---- settings ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:set', patch),
  pickDownloadDir: () => ipcRenderer.invoke('dialog:openDir')
})
