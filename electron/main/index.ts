import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
