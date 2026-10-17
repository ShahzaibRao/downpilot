import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Quality, type Tools } from '../download/engine'
import { QueueManager, type NewTaskInput } from '../download/queue'
import { HistoryStore } from '../history'
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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---- IPC: downloads — queue (Phase 1c) ----

interface ToolPaths {
  ytdlp?: string
  ffmpegDir?: string
  gallerydl?: string
}

let toolPathsCache: ToolPaths | null = null

/** Resolve tool locations via the sidecar (cached for the session). Missing tools stay undefined. */
async function toolPaths(): Promise<ToolPaths> {
  if (toolPathsCache) return toolPathsCache
  const { stdout } = await execFileAsync(
    sidecarPath(),
    ['detect', '--managed-dir', managedDir(), '--json'],
    { timeout: 120_000 }
  )
  const results = (JSON.parse(stdout) as { results: Array<{ kind: string; found: boolean; path?: string }> }).results
  const byKind = new Map(results.map((r) => [r.kind, r]))
  const pick = (kind: string): string | undefined => {
    const r = byKind.get(kind)
    return r?.found && r.path ? r.path : undefined
  }
  const ffmpeg = pick('ffmpeg')
  toolPathsCache = {
    ytdlp: pick('yt-dlp'),
    ffmpegDir: ffmpeg ? path.dirname(ffmpeg) : undefined,
    gallerydl: pick('gallery-dl')
  }
  return toolPathsCache
}

let queue: QueueManager | null = null
let history: HistoryStore | null = null

function getHistory(): HistoryStore {
  if (!history) {
    history = new HistoryStore(path.join(app.getPath('userData'), 'history.json'), (entries) => {
      if (mainWindow) mainWindow.webContents.send('history:update', entries)
    })
  }
  return history
}

function getQueue(): QueueManager {
  if (!queue) {
    queue = new QueueManager(
      path.join(app.getPath('userData'), 'queue.json'),
      () => toolPaths(),
      () => getSettings().downloadDir,
      (tasks) => {
        if (mainWindow) mainWindow.webContents.send('queue:update', tasks)
      },
      (task) => {
        // finished task → history (last 100)
        getHistory().add({
          id: task.id,
          url: task.url,
          filename: task.filename || task.url,
          engine: task.engine,
          quality: task.quality,
          status: task.status === 'done' ? 'done' : 'failed',
          error: task.error,
          downloaded: task.downloaded,
          completedAt: Date.now()
        })
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
ipcMain.handle('history:clear', async () => {
  getHistory().clear()
  return true
})

// ---- IPC: settings ----

ipcMain.handle('settings:get', async () => getSettings())

ipcMain.handle('settings:set', async (_event, patch: { downloadDir?: string; maxConcurrent?: number }) => {
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
