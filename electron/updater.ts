/**
 * Auto-updater via electron-updater + GitHub Releases (Track A).
 * - Checks on startup (after 10s) + daily
 * - Downloads in background, prompts restart (never forces mid-download)
 * - v1 is UNSIGNED — SmartScreen warning expected on fresh install
 */
import { app, BrowserWindow, dialog } from 'electron'

// Lazy-load electron-updater (only in packaged app, not dev)
// This avoids "Cannot find module" errors in dev mode.
let autoUpdater: any = null
async function getUpdater() {
  if (!autoUpdater) {
    const mod: any = await import('electron-updater')
    // Handle different export styles (named, default, or direct)
    autoUpdater = mod.autoUpdater || mod.default?.autoUpdater || mod.default
    if (!autoUpdater) {
      throw new Error('electron-updater module loaded but autoUpdater not found')
    }
  }
  return autoUpdater
}

let mainWindow: BrowserWindow | null = null
let checkInterval: NodeJS.Timeout | null = null

export function initUpdater(window: BrowserWindow): void {
  mainWindow = window

  // Only in packaged app (not dev)
  if (!app.isPackaged) {
    console.log('[updater] skipped (dev mode)')
    return
  }

  // Lazy load in packaged app only
  void getUpdater().then((updater) => {
    setupUpdater(updater)
  }).catch((e) => {
    console.error('[updater] failed to load:', e.message)
  })
}

let checkTimeout: NodeJS.Timeout | null = null

function clearCheckTimeout(): void {
  if (checkTimeout) {
    clearTimeout(checkTimeout)
    checkTimeout = null
  }
}

function setupUpdater(autoUpdater: any): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update...')
    sendStatus('checking')
  })

  autoUpdater.on('update-available', (info: any) => {
    clearCheckTimeout()
    console.log(`[updater] update available: ${info.version}`)
    sendStatus('available', info.version)
  })

  autoUpdater.on('update-not-available', () => {
    clearCheckTimeout()
    console.log('[updater] up to date')
    sendStatus('up-to-date')
  })

  autoUpdater.on('download-progress', (p: any) => {
    sendStatus('downloading', undefined, Math.round(p.percent))
  })

  autoUpdater.on('update-downloaded', (info: any) => {
    clearCheckTimeout()
    console.log(`[updater] downloaded: ${info.version}`)
    sendStatus('downloaded', info.version)
    // Prompt restart (never force)
    dialog.showMessageBox(mainWindow!, {
      type: 'info',
      title: 'Update ready',
      message: `DownPilot ${info.version} downloaded. Restart to apply?`,
      buttons: ['Restart now', 'Later'],
      defaultId: 0
    }).then((r) => {
      if (r.response === 0) {
        autoUpdater.quitAndInstall(false, true)
      }
    })
  })

  autoUpdater.on('error', (err: Error) => {
    clearCheckTimeout()
    console.error('[updater] error:', err.message)
    sendStatus('error', undefined, undefined, err.message)
  })

  // Check on startup (after 10s), then daily
  setTimeout(() => checkForUpdates(), 10000)
  checkInterval = setInterval(() => checkForUpdates(), 24 * 60 * 60 * 1000)
}

export function checkForUpdates(): void {
  if (!app.isPackaged) return
  sendStatus('checking')
  // First: test if app's network stack can reach GitHub at all
  testConnectivity().then((connResult) => {
    if (!connResult.ok) {
      clearCheckTimeout()
      sendStatus('error', undefined, undefined, `Network test failed: ${connResult.error}`)
      return
    }
    // Network OK, now check for updates
    clearCheckTimeout()
    checkTimeout = setTimeout(() => {
      checkTimeout = null
      sendStatus('error', undefined, undefined, 'Update check timed out after 30s')
    }, 30000)
    void getUpdater().then((updater) => {
      updater.checkForUpdates().catch((e: any) => {
        clearCheckTimeout()
        const msg = e?.message || e?.stack?.split('\n')[0] || String(e) || 'Unknown error'
        console.error('[updater] check failed:', msg)
        sendStatus('error', undefined, undefined, msg.slice(0, 200))
      })
    }).catch((e: any) => {
      clearCheckTimeout()
      const msg = e?.message || String(e) || 'Failed to load updater'
      sendStatus('error', undefined, undefined, msg.slice(0, 200))
    })
  })
}

/** Test if the app can reach api.github.com (diagnoses network vs updater issues) */
async function testConnectivity(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { net } = await import('electron')
    return new Promise((resolve) => {
      const req = net.request('https://api.github.com/repos/ShahzaibRao/downpilot/releases/latest')
      req.setHeader('User-Agent', 'DownPilot-updater')
      req.setHeader('Accept', 'application/vnd.github.v3+json')
      const timeout = setTimeout(() => {
        req.abort()
        resolve({ ok: false, error: 'Connection to api.github.com timed out (10s)' })
      }, 10000)
      req.on('response', (res: any) => {
        clearTimeout(timeout)
        if (res.statusCode === 200 || res.statusCode === 403) {
          resolve({ ok: true })
        } else {
          resolve({ ok: false, error: `GitHub API returned ${res.statusCode}` })
        }
      })
      req.on('error', (e: Error) => {
        clearTimeout(timeout)
        resolve({ ok: false, error: e.message || 'Network error' })
      })
      req.end()
    })
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Test failed' }
  }
}

function sendStatus(
  status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error',
  version?: string,
  percent?: number,
  error?: string
): void {
  mainWindow?.webContents.send('updater:status', { status, version, percent, error })
}

export function stopUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}
