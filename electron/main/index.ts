import { app, BrowserWindow, dialog, ipcMain, shell, Notification, Menu } from 'electron'
import * as fs from 'node:fs'
import { initUpdater, checkForUpdates, stopUpdater } from '../updater'
import { NotificationStore } from '../notifications'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Quality, type Tools } from '../download/engine'
import { QueueManager, type NewTaskInput } from '../download/queue'
import { HistoryStore } from '../history'
import { ProspectStore } from '../prospects/store'
import { SeenStore } from '../prospects/seen'
import { ProspectScheduler, DEFAULT_MAX_NEW } from '../prospects/scheduler'
import { CookieVault, platformForUrl } from '../cookies'
import { PotManager } from '../pot'
import { ProxyRotator, buildProxyUrl, selectedProxies, testProxy, testSite } from '../smartmode'
import { getSettings, setSettings } from '../settings'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)
const isDev = !app.isPackaged

/**
 * Sidecar binary resolution.
 * Dev:  <repo>/backend/bin/dp-deps(.exe) — build it with `npm run sidecar:build`
 * Prod: <resources>/backend/bin/dp-deps(.exe) — bundled by electron-builder
 */
function sidecarPath(): string {
  const exe = process.platform === 'win32' ? 'dp-deps.exe' : 'dp-deps'
  if (isDev) return path.resolve(__dirname, '../../backend/bin', exe)
  return path.join(process.resourcesPath, 'backend', 'bin', exe)
}

/** Where the sidecar installs managed deps: <userData>/runtime/bin */
function managedDir(): string {
  return path.join(app.getPath('userData'), 'runtime', 'bin')
}

/** Run the sidecar and stream its NDJSON stdout, one parsed event per line. */
function streamNdjson(
  bin: string,
  args: string[],
  onEvent: (evt: Record<string, unknown>) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        try {
          onEvent(JSON.parse(t) as Record<string, unknown>)
        } catch {
          /* ignore non-JSON lines */
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`dp-deps exited with code ${code}: ${stderr.slice(-500)}`))
    })
  })
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    title: 'DownPilot',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // DevTools: Ctrl+Shift+I se kholo (auto-open hata diya — extra window tang karti hai)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---- IPC: dependency sidecar ----

/** Full dep status: dp-deps detect --json */
ipcMain.handle('deps:status', async () => {
  const { stdout } = await execFileAsync(
    sidecarPath(),
    ['detect', '--managed-dir', managedDir(), '--json'],
    { timeout: 120_000 }
  )
  return JSON.parse(stdout) as unknown
})

/**
 * Fetch deps. Progress streams back as 'deps:progress' events;
 * the invoke promise resolves when the sidecar exits 0.
 */
ipcMain.handle('deps:fetch', async (event, only?: string[]) => {
  const args = ['fetch', '--managed-dir', managedDir()]
  if (only && only.length > 0) args.push('--only', only.join(','))
  await streamNdjson(sidecarPath(), args, (evt) => {
    event.sender.send('deps:progress', evt)
  })
  return true
})

app.whenReady().then(() => {
  // Remove the default application menu (File/Edit/View/Window) — cleaner look
  Menu.setApplicationMenu(null)
  createWindow()
  // Phase 4: auto-updater (GitHub Releases)
  if (mainWindow) initUpdater(mainWindow)
  // Phase 3b: start the prospect auto-watch scheduler (60-min cycle).
  try {
    getProspectScheduler().start()
  } catch {
    /* best-effort */
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Phase 4: stop updater interval
  try { stopUpdater() } catch { /* best-effort */ }
  // Phase 2b: kill the Deno POT server (if running) on app quit.
  try {
    potManager?.stop()
  } catch {
    /* best-effort */
  }
  // Phase 3b: stop the prospect scheduler.
  try {
    prospectScheduler?.stop()
  } catch {
    /* best-effort */
  }
  // perf/quit-cleanup: kill all running download processes so no orphan
  // yt-dlp/gallery-dl/ffmpeg survives after the app closes.
  try {
    getQueue().shutdown()
  } catch {
    /* best-effort */
  }
})

// ---- IPC: downloads — queue (Phase 1c) ----

interface ToolPaths {
  ytdlp?: string
  ffmpegDir?: string
  gallerydl?: string
  deno?: string
}

let toolPathsCache: ToolPaths | null = null

/** Resolve tool locations via the sidecar (cached for the session). Missing tools stay undefined. */
async function toolPaths(): Promise<ToolPaths> {
  if (toolPathsCache) {
    // If cache has neither engine, it was a bad detection — retry.
    if (!toolPathsCache.ytdlp && !toolPathsCache.gallerydl) {
      toolPathsCache = null
    } else {
      return toolPathsCache
    }
  }
  const { stdout } = await execFileAsync(
    sidecarPath(),
    ['detect', '--managed-dir', managedDir(), '--json'],
    { timeout: 120_000 }
  )
  const results = (JSON.parse(stdout) as { results: Array<{ kind: string; found: boolean; path?: string }> }).results
  for (const r of results) {
  }
  const byKind = new Map(results.map((r) => [r.kind, r]))
  const pick = (kind: string): string | undefined => {
    const r = byKind.get(kind)
    return r?.found && r.path ? r.path : undefined
  }
  const ffmpeg = pick('ffmpeg')
  toolPathsCache = {
    ytdlp: pick('yt-dlp'),
    ffmpegDir: ffmpeg ? path.dirname(ffmpeg) : undefined,
    gallerydl: pick('gallery-dl'),
    deno: pick('deno')
  }
  if (!toolPathsCache.ytdlp) console.error('[tools] WARNING: yt-dlp not found!')
  if (!toolPathsCache.gallerydl) console.error('[tools] WARNING: gallery-dl not found!')
  return toolPathsCache
}

let queue: QueueManager | null = null
let history: HistoryStore | null = null
let prospectStore: ProspectStore | null = null
let seenStore: SeenStore | null = null
let cookieVault: CookieVault | null = null

function getProspectStore(): ProspectStore {
  if (!prospectStore) prospectStore = new ProspectStore()
  return prospectStore
}

function getSeenStore(): SeenStore {
  if (!seenStore) seenStore = new SeenStore()
  return seenStore
}

let prospectScheduler: ProspectScheduler | null = null

let notificationStore: NotificationStore | null = null

function getNotificationStore(): NotificationStore {
  if (!notificationStore) notificationStore = new NotificationStore()
  return notificationStore
}

function getProspectScheduler(): ProspectScheduler {
  if (!prospectScheduler) {
    prospectScheduler = new ProspectScheduler({
      getTools: () => toolPaths(),
      getStore: () => getProspectStore(),
      getSeen: () => getSeenStore(),
      getQueue: () => getQueue(),
      getDownloadDir: () => getSettings().downloadDir,
      getCookiesFile: (platform: string) => {
        try {
          return getCookieVault().materialize(platform)
        } catch {
          return null
        }
      },
      getProxyUrl: (url: string) => {
        try {
          return proxyRotator.nextFor(url, getSettings().smartMode)
        } catch {
          return null
        }
      },
      getMaxNew: () => {
        try {
          return getSettings().maxNewPerCheck
        } catch {
          return DEFAULT_MAX_NEW
        }
      },
      onCheckDone: (results) => {
        // in-app + native notifications for new content
        const store = getNotificationStore()
        for (const r of results) {
          if (r.newItems > 0) {
            store.add(
              `New from ${r.prospectName}`,
              `${r.newItems} new item(s), ${r.queued} queued for download`,
              r.prospectId,
              r.prospectName
            )
          }
          if (r.error) {
            const p = getProspectStore().get(r.prospectId)
            if (p && p.status === 'paused' && p.failCount >= 3) {
              store.add(
                `${r.prospectName} auto-paused`,
                `3 consecutive check failures. Last: ${r.error}`,
                r.prospectId,
                r.prospectName
              )
            }
          }
        }
        const totalNew = results.reduce((n, r) => n + r.newItems, 0)
        if (totalNew > 0 && Notification.isSupported()) {
          new Notification({
            title: 'DownPilot — new content',
            body: `${totalNew} new item(s) from ${results.filter((r) => r.newItems > 0).length} prospect(s) queued`
          }).show()
        }
        if (mainWindow) {
          mainWindow.webContents.send('prospects:checkDone', results)
          mainWindow.webContents.send('notify:update', getNotificationStore().list())
        }
      }
    })
  }
  return prospectScheduler
}
let potManager: PotManager | null = null
const proxyRotator = new ProxyRotator()

/** Vendored POT server source: repo in dev, app resources in prod. */
function potSourceDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'pot', 'server')
  return path.join(app.getAppPath(), 'pot', 'server')
}

function getPotManager(): PotManager {
  if (!potManager) {
    potManager = new PotManager(
      potSourceDir(),
      async () => (await toolPaths()).deno ?? null,
    )
  }
  return potManager
}

function getHistory(): HistoryStore {
  if (!history) {
    history = new HistoryStore(path.join(app.getPath('userData'), 'history.json'), (entries) => {
      if (mainWindow) mainWindow.webContents.send('history:update', entries)
    })
  }
  return history
}

// Phase 5: speed tracking (session top + rolling 60s history)
// Calculates speed from downloaded-bytes delta (more reliable than yt-dlp speed_str)
let sessionTopSpeed = 0
let speedHistory: number[] = new Array(60).fill(0)
let lastSample: { time: number; bytes: number } | null = null

function parseSpeedStr(s: string): number {
  const m = String(s || '').match(/([\d.]+)\s*([KMGT]?i?B)\/s/i)
  if (!m) return 0
  const v = parseFloat(m[1])
  const u = m[2].toUpperCase().replace('I', '')
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 }
  return v * (mult[u] || 0)
}

function trackSpeed(tasks: any[]): void {
  const now = Date.now()
  let totalBytes = 0
  let ytSpeed = 0
  for (const t of tasks) {
    if (t.status === 'running') {
      totalBytes += t.downloaded || 0
      ytSpeed += parseSpeedStr(t.speed)
    }
  }

  // Prefer calculated speed from bytes delta; fallback to yt-dlp speed_str
  let current = 0
  if (lastSample && now > lastSample.time) {
    const dt = (now - lastSample.time) / 1000
    const db = totalBytes - lastSample.bytes
    // Sanity: ignore if bytes went backwards (new task) or spike > 1 GB/s
    if (dt > 0 && db >= 0) {
      current = db / dt
      if (current > 1024 * 1024 * 1024) current = 0 // cap: ignore >1GB/s spikes
    }
  }
  lastSample = { time: now, bytes: totalBytes }
  if (current === 0 && ytSpeed > 0 && ytSpeed < 1024 * 1024 * 1024) current = ytSpeed

  if (current > sessionTopSpeed) sessionTopSpeed = current
  speedHistory = [...speedHistory.slice(1), current]
}

// Phase 5: persistent dashboard stats (independent of history)
let statsStore: import('../stats-store').StatsStore | null = null
function getStatsStore(): import('../stats-store').StatsStore {
  if (!statsStore) {
    const { StatsStore } = require('../stats-store') as typeof import('../stats-store')
    statsStore = new StatsStore(app.getPath('userData'))
  }
  return statsStore
}

function getCookieVault(): CookieVault {
  if (!cookieVault) {
    cookieVault = new CookieVault((metas) => {
      if (mainWindow) mainWindow.webContents.send('cookies:update', metas)
    })
  }
  return cookieVault
}

function getQueue(): QueueManager {
  if (!queue) {
    queue = new QueueManager(
      path.join(app.getPath('userData'), 'queue.json'),
      () => toolPaths(),
      () => getSettings().downloadDir,
      (tasks) => {
        // Phase 5: track speed (session top + rolling history for live graph)
        trackSpeed(tasks)
        if (mainWindow) mainWindow.webContents.send('queue:update', tasks)
      },
      (task) => {
        // finished task → history (last 100)
        const prospect = task.prospectId ? getProspectStore().get(task.prospectId) : undefined
        // Get actual file size from disk (progress events can report 0)
        let downloadedBytes = task.downloaded || 0
        if (task.status === 'done' && task.filename && downloadedBytes === 0) {
          try {
            const fsMod = require('node:fs') as typeof import('node:fs')
            const pathMod = require('node:path') as typeof import('node:path')
            const dir = task.outDir || getSettings().downloadDir
            const fullPath = pathMod.join(dir, task.filename)
            const st = fsMod.statSync(fullPath)
            if (st.isFile()) downloadedBytes = st.size
          } catch { /* file may not exist, keep 0 */ }
        }
        getHistory().add({
          id: task.id,
          url: task.url,
          filename: task.filename || task.url,
          engine: task.engine,
          quality: task.quality,
          status: task.status === 'done' ? 'done' : 'failed',
          error: task.error,
          downloaded: downloadedBytes,
          completedAt: Date.now(),
          ...(task.prospectId ? { prospectId: task.prospectId } : {}),
          ...(prospect ? { prospectName: prospect.name } : {})
        })
        // Phase 5: record to persistent stats store (independent of history)
        const { platformFromUrl, isImageFile } = require('../stats') as typeof import('../stats')
        getStatsStore().recordDownload({
          bytes: downloadedBytes,
          platform: platformFromUrl(task.url),
          creatorName: prospect?.name,
          isImage: isImageFile(task.filename || ''),
          success: task.status === 'done'
        })
        // prospect task: seen was marked at queue time (standing rule: deleted
        // files never re-download). On failure, unmark so next check retries.
        if (task.prospectId && task.prospectItemId && task.status !== 'done') {
          getSeenStore().unmark(task.prospectId, task.prospectItemId)
        }
      },
      {
        getCookiesFile: (platform: string) => getCookieVault().materialize(platform),
        markExpired: (platform: string) => getCookieVault().markExpired(platform)
      },
      {
        ensureForYoutube: async () => {
          const ok = await getPotManager().ensureRunning()
          return ok ? getPotManager().pluginDir() : null
        }
      },
      {
        // Smart Mode: round-robin across the user's selected proxies.
        getProxyUrl: (url: string) => {
          try {
            return proxyRotator.nextFor(url, getSettings().smartMode)
          } catch {
            return null
          }
        }
      }
    )
    // settings is the source of truth for concurrency
    queue.setMaxConcurrent(getSettings().maxConcurrent)
  }
  return queue
}

async function requireEngines(): Promise<void> {
  const tools = await toolPaths()
  if (!tools.ytdlp && !tools.gallerydl) {
    throw new Error('No download engine installed — get yt-dlp or gallery-dl from Settings first')
  }
}

ipcMain.handle('queue:list', async () => getQueue().list())
ipcMain.handle('queue:add', async (_event, opts: { url: string; quality: Quality; scopeOpts?: NewTaskInput['scopeOpts'] }) => {
  const url = opts.url.trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('Please paste a valid http(s) link')
  await requireEngines()
  return getQueue().add(url, opts.quality, opts.scopeOpts)
})
ipcMain.handle('queue:pause', async (_event, id: string) => {
  getQueue().pause(id)
  return true
})
ipcMain.handle('queue:resume', async (_event, id: string) => {
  getQueue().resume(id)
  return true
})
ipcMain.handle('queue:retry', async (_event, id: string) => {
  getQueue().retry(id)
  return true
})
ipcMain.handle('queue:cancel', async (_event, id: string) => {
  getQueue().cancel(id)
  return true
})
ipcMain.handle('queue:clearDone', async () => {
  getQueue().clearDone()
  return true
})
ipcMain.handle('queue:addBulk', async (_event, items: NewTaskInput[]) => {
  await requireEngines()
  const clean = (Array.isArray(items) ? items : [])
    .filter((i) => i && typeof i.url === 'string' && /^https?:\/\//i.test(i.url.trim()))
    .slice(0, 500)
  return getQueue().addMany(clean)
})

// ---- IPC: history (Phase 1d, last 100 finished tasks) ----

ipcMain.handle('history:list', async () => getHistory().list())

// Phase 5: dashboard stats
ipcMain.handle('stats:get', async () => {
  const { computeStats } = await import('../stats')
  const stats = computeStats(getStatsStore(), getHistory(), getQueue(), getProspectStore())
  // Inject live speed data (tracked in main process)
  stats.topSpeed = sessionTopSpeed
  ;(stats as any).speedHistory = speedHistory
  ;(stats as any).currentSpeed = speedHistory[speedHistory.length - 1] || 0
  // Store health (fix/durable-saves): dashboard banner reads this.
  ;(stats as any).storeStatus = getStatsStore().status()
  return stats
})

ipcMain.handle('stats:reset', async () => {
  getStatsStore().reset()
  return true
})
ipcMain.handle('history:clear', async () => {
  getHistory().clear()
  return true
})

// ---- IPC: cookie profiles (Phase 2a) ----

ipcMain.handle('cookies:list', async () => getCookieVault().list())

ipcMain.handle('cookies:add', async (_event, opts: { platform: string; content: string }) => {
  if (!opts.platform || typeof opts.content !== 'string' || !opts.content.trim()) {
    throw new Error('Pick a platform and paste your cookies.txt content')
  }
  return getCookieVault().add(opts.platform, opts.content)
})

ipcMain.handle('cookies:remove', async (_event, platform: string) => {
  getCookieVault().remove(platform)
  return true
})

/**
 * Live test: run yt-dlp metadata extraction with the profile's cookies
 * against a user-supplied URL. Success = cookies work.
 */
ipcMain.handle('cookies:test', async (_event, opts: { platform: string; testUrl: string }) => {
  const url = (opts.testUrl ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('Give a valid test URL (e.g. an Instagram post link)')
  const platform = platformForUrl(url) ?? opts.platform
  const file = getCookieVault().materialize(platform)
  if (!file) throw new Error(`No cookie profile for ${platform} — add one first`)
  const tools = await toolPaths()
  if (!tools.ytdlp) throw new Error('yt-dlp is not installed — get it from Settings first')
  try {
    await execFileAsync(
      tools.ytdlp,
      ['--cookies', file, '--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist', url],
      { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 }
    )
    getCookieVault().markTested(platform, true)
    return { ok: true }
  } catch (err) {
    getCookieVault().markTested(platform, false)
    const msg = (err as Error).message.split('\n').find((l) => /ERROR/i.test(l)) ?? 'Cookie test failed'
    throw new Error(msg.trim())
  }
})

// ---- IPC: Prospects (Phase 3a) ----

ipcMain.handle('prospects:list', async () => {
  return getProspectStore().list()
})

ipcMain.handle('prospects:add', async (_event, url: string, name?: string, quality?: string, intervalMinutes?: number) => {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('Enter a valid http(s) profile URL')
  const q = ['best', '4k', '1080p', '720p', '480p'].includes(quality ?? '') ? quality as 'best' | '4k' | '1080p' | '720p' | '480p' : 'best'
  return getProspectStore().add(url, name, q, intervalMinutes)
})

ipcMain.handle('prospects:addLink', async (_event, prospectId: string, url: string) => {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('Enter a valid http(s) URL')
  return getProspectStore().addLink(prospectId, url)
})

ipcMain.handle('prospects:removeLink', async (_event, prospectId: string, linkId: string) => {
  getProspectStore().removeLink(prospectId, linkId)
  return true
})

ipcMain.handle('prospects:remove', async (_event, id: string) => {
  getProspectStore().remove(id)
  getSeenStore().clearProspect(id)
  return true
})

ipcMain.handle('prospects:rename', async (_event, id: string, name: string) => {
  return getProspectStore().rename(id, name)
})

ipcMain.handle('prospects:setStatus', async (_event, id: string, status: 'ok' | 'paused' | 'error') => {
  getProspectStore().setStatus(id, status)
  return true
})

ipcMain.handle('prospects:unpause', async (_event, id: string) => {
  getProspectStore().unpause(id)
  return true
})

ipcMain.handle('prospects:unpauseLink', async (_event, prospectId: string, linkId: string) => {
  getProspectStore().unpauseLink(prospectId, linkId)
  return true
})

ipcMain.handle('prospects:openFolder', async (_event, id: string) => {
  const p = getProspectStore().get(id)
  if (!p) return false
  const folderPath = path.join(getSettings().downloadDir, 'prospects', p.folder)
  // Create folder if it doesn't exist, then open
  try {
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true })
    await shell.openPath(folderPath)
    return true
  } catch {
    return false
  }
})

// ---- IPC: prospects import/export (fix/durable-saves) ----
// Export file format (v1): { format: 'downpilot-prospects', version, exportedAt,
// mode: 'backup'|'share', prospects: [{id,name,folder,quality,intervalMinutes,links}],
// seen?: { prospectId: [itemId...] } } — seen only in backup mode (migration +
// restore without re-downloads). Cookies/proxies are NEVER exported.

interface ExportProspect {
  id: string
  name: string
  folder: string
  quality: Quality
  intervalMinutes: number
  links: Array<{ url: string; platform: string }>
}

interface ProspectsExportFile {
  format: string
  version: number
  exportedAt: string
  mode: 'backup' | 'share'
  prospects: ExportProspect[]
  seen?: Record<string, string[]>
}

/** Parsed import waiting for user confirmation (picked but not yet applied). */
let pendingImport: ProspectsExportFile | null = null

ipcMain.handle('prospects:export', async (_event, mode: 'backup' | 'share') => {
  try {
    const store = getProspectStore()
    const prospects: ExportProspect[] = store.list().map((p) => ({
      id: p.id,
      name: p.name,
      folder: p.folder,
      quality: p.quality,
      intervalMinutes: p.intervalMinutes,
      links: p.links.map((l) => ({ url: l.url, platform: l.platform }))
    }))
    const out: ProspectsExportFile = {
      format: 'downpilot-prospects',
      version: 1,
      exportedAt: new Date().toISOString(),
      mode,
      prospects
    }
    if (mode === 'backup') {
      // Group seen keys by prospect id so import can remap them.
      const seen: Record<string, string[]> = {}
      for (const key of getSeenStore().allKeys()) {
        const idx = key.indexOf(':')
        if (idx <= 0) continue
        const pid = key.slice(0, idx)
        const item = key.slice(idx + 1)
        if (!seen[pid]) seen[pid] = []
        seen[pid].push(item)
      }
      out.seen = seen
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const res = await dialog.showSaveDialog({
      title: mode === 'backup' ? 'Save prospects backup' : 'Share prospects',
      defaultPath: `downpilot-prospects-${mode}-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true }
    // fsync so the export survives a power cut too.
    const fd = fs.openSync(res.filePath, 'w')
    try {
      fs.writeFileSync(fd, JSON.stringify(out, null, 2))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    return { ok: true, path: res.filePath, count: prospects.length }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('prospects:importPick', async () => {
  try {
    const res = await dialog.showOpenDialog({
      title: 'Import prospects',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, cancelled: true }
    const raw = fs.readFileSync(res.filePaths[0], 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.format !== 'downpilot-prospects' || !Array.isArray(parsed?.prospects)) {
      return { ok: false, error: 'Ye DownPilot prospects file nahi hai.' }
    }
    const prospects = (parsed.prospects as any[]).filter(
      (p) => p?.name && Array.isArray(p?.links) && p.links.length > 0
    )
    pendingImport = {
      format: parsed.format,
      version: parsed.version ?? 1,
      exportedAt: parsed.exportedAt ?? '',
      mode: parsed.mode === 'share' ? 'share' : 'backup',
      prospects: prospects.map((p: any) => ({
        id: String(p.id ?? ''),
        name: String(p.name),
        folder: String(p.folder ?? ''),
        quality: p.quality ?? 'best',
        intervalMinutes: p.intervalMinutes ?? 60,
        links: (p.links as any[]).filter((l) => l?.url).map((l) => ({ url: String(l.url), platform: String(l.platform ?? '') }))
      })),
      seen: parsed.mode === 'share' ? undefined : (parsed.seen as Record<string, string[]> | undefined)
    }
    return {
      ok: true,
      count: pendingImport.prospects.length,
      names: pendingImport.prospects.map((p) => p.name),
      mode: pendingImport.mode,
      hasSeen: !!pendingImport.seen
    }
  } catch (e) {
    return { ok: false, error: `File parhi nahi gayi: ${(e as Error).message}` }
  }
})

ipcMain.handle('prospects:importApply', async () => {
  if (!pendingImport) return { ok: false, error: 'Koi import pending nahi hai.' }
  const data = pendingImport
  pendingImport = null
  try {
    const store = getProspectStore()
    const result = store.importProspects(data.prospects)
    // Remap seen data through old→new IDs (backup mode only; skipped
    // prospects' seen data is dropped — their items stay as-is).
    let seenImported = 0
    if (data.seen) {
      const keys: string[] = []
      for (const [oldId, itemIds] of Object.entries(data.seen)) {
        const newId = result.idMap.get(oldId)
        if (!newId) continue
        for (const itemId of itemIds || []) keys.push(`${newId}:${itemId}`)
      }
      seenImported = getSeenStore().importKeys(keys)
    }
    return { ok: true, added: result.added, skipped: result.skipped, seenImported }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
})

ipcMain.handle('prospects:status', async () => {
  return getProspectStore().status()
})

ipcMain.handle('prospects:checkNow', async () => {
  return getProspectScheduler().checkAll()
})

ipcMain.handle('prospects:checkOne', async (_event, id: string) => {
  return getProspectScheduler().checkOne(id)
})

ipcMain.handle('prospects:updateLink', async (_event, prospectId: string, linkId: string, newUrl: string) => {
  return getProspectStore().updateLink(prospectId, linkId, newUrl)
})

ipcMain.handle('prospects:setQuality', async (_event, id: string, quality: string) => {
  return getProspectStore().setQuality(id, quality as 'best' | '4k' | '1080p' | '720p' | '480p')
})

ipcMain.handle('prospects:setInterval', async (_event, id: string, minutes: number) => {
  return getProspectStore().setInterval(id, minutes)
})

// ---- IPC: notifications (Phase 3c) ----

ipcMain.handle('notify:list', async () => {
  return getNotificationStore().list()
})

ipcMain.handle('notify:markRead', async (_event, id: string) => {
  getNotificationStore().markRead(id)
  return true
})

ipcMain.handle('notify:markAllRead', async () => {
  getNotificationStore().markAllRead()
  return true
})

ipcMain.handle('notify:clear', async () => {
  getNotificationStore().clear()
  return true
})

// ---- IPC: shell (Phase 3c) ----

ipcMain.handle('shell:openPath', async (_event, targetPath: string) => {
  await shell.openPath(targetPath)
  return true
})

ipcMain.handle('shell:openProspectFolder', async (_event, prospectId: string) => {
  const p = getProspectStore().get(prospectId)
  if (!p) throw new Error('Prospect not found')
  const folder = path.join(getSettings().downloadDir, 'prospects', p.folder)
  await shell.openPath(folder)
  return true
})

// ---- IPC: Smart Mode proxy tests (Phase 2c) ----

/** Selected proxies with usable URLs. Throws if none. */
function requireSelectedProxies(): Array<{ id: string; name: string; url: string }> {
  const cfg = getSettings().smartMode
  const selected = selectedProxies(cfg)
  if (selected.length === 0) throw new Error('Select at least one proxy for rotation (tick the checkboxes)')
  const usable = []
  for (const p of selected) {
    // don't log the URL — it contains credentials
    const url = buildProxyUrl(p)
    if (url) usable.push({ id: p.id, name: p.name || 'Unnamed', url })
  }
  if (usable.length === 0) throw new Error('Selected proxies have no host — edit and save them')
  return usable
}

ipcMain.handle('proxy:test', async () => {
  const results = []
  for (const p of requireSelectedProxies()) {
    const r = await testProxy(p.url)
    results.push({ id: p.id, name: p.name, ok: r.ok, ip: r.ip, error: r.error })
  }
  return results
})

ipcMain.handle('proxy:testSite', async (_event, siteUrl: string) => {
  const results = []
  for (const p of requireSelectedProxies()) {
    const r = await testSite(p.url, siteUrl)
    results.push({ id: p.id, name: p.name, ok: r.ok, status: r.status, error: r.error })
  }
  return results
})

// ---- IPC: POT server status (Phase 2b, surfaced in Settings) ----

ipcMain.handle('pot:status', async () => {
  const tools = await toolPaths()
  const pm = getPotManager()
  // /ping without starting: reuse PotManager's check via a lightweight fetch
  let running = false
  let version: string | null = null
  try {
    const res = await fetch('http://127.0.0.1:4416/ping', { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const data = (await res.json()) as { version?: string }
      if (typeof data.version === 'string') {
        running = true
        version = data.version
      }
    }
  } catch {
    /* not running */
  }
  return {
    denoPath: tools.deno ?? null,
    filesReady: pm.filesReady(),
    running,
    isOurs: pm.isOurs(),
    version,
    port: 4416
  }
})

ipcMain.handle('pot:start', async () => {
  const ok = await getPotManager().ensureRunning()
  if (!ok) throw new Error('POT server failed to start — check the terminal log')
  return true
})

ipcMain.handle('pot:stop', async () => {
  getPotManager().stop()
  return true
})

ipcMain.handle('pot:forceStop', async () => {
  const killed = await getPotManager().forceStop()
  if (!killed) throw new Error('Nothing found listening on :4416')
  return true
})

// ---- IPC: settings ----

ipcMain.handle('settings:get', async () => getSettings())

ipcMain.handle('settings:set', async (_event, patch: Partial<import('../settings').Settings>) => {
  const next = setSettings(patch)
  // keep the queue's concurrency in sync with settings
  getQueue().setMaxConcurrent(next.maxConcurrent)
  return next
})

/** Let the user pick the download folder. Returns the path or null. */
ipcMain.handle('dialog:openDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose download folder'
  })
  return res.canceled ? null : res.filePaths[0]
})

// Phase 4: manual update check
ipcMain.handle('updater:check', async () => {
  checkForUpdates()
  return { ok: true }
})
ipcMain.handle('updater:version', async () => app.getVersion())
