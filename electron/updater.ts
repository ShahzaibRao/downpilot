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
    const mod = await import('electron-updater')
    autoUpdater = mod.autoUpdater
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
    sendStatus('error', err.message)
  })

  // Check on startup (after 10s), then daily
  setTimeout(() => checkForUpdates(), 10000)
  checkInterval = setInterval(() => checkForUpdates(), 24 * 60 * 60 * 1000)
}

export function checkForUpdates(): void {
  if (!app.isPackaged) return
  sendStatus('checking')
  // Timeout: if no response in 30s, report error (don't hang on "checking...")
  clearCheckTimeout()
  checkTimeout = setTimeout(() => {
    checkTimeout = null
    sendStatus('error', 'Update check timed out (network issue?)')
  }, 30000)
  void getUpdater().then((updater) => {
    updater.checkForUpdates().catch((e: Error) => {
      clearCheckTimeout()
      console.error('[updater] check failed:', e.message)
      sendStatus('error', e.message)
    })
  })
}

function sendStatus(
  status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error',
  version?: string,
  percent?: number
): void {
  mainWindow?.webContents.send('updater:status', { status, version, percent })
}

export function stopUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}
