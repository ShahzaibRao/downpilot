import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

export interface ProxyConfig {
  host: string
  port: number
  username: string
  password: string
}

export interface SmartModeConfig {
  enabled: boolean
  proxy: ProxyConfig
  /** Platforms that use the proxy: subset of SMART_PLATFORMS, or ['all']. */
  platforms: string[]
}

export interface Settings {
  downloadDir: string
  maxConcurrent: number
  smartMode: SmartModeConfig
}

const defaults = (): Settings => ({
  downloadDir: path.join(app.getPath('downloads'), 'DownPilot'),
  maxConcurrent: 1,
  smartMode: {
    enabled: false,
    proxy: { host: '', port: 8080, username: '', password: '' },
    platforms: ['all']
  }
})

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** Tiny JSON settings store. */
export function getSettings(): Settings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = { ...defaults(), ...JSON.parse(raw) }
    parsed.maxConcurrent = Math.min(8, Math.max(1, Math.floor(parsed.maxConcurrent) || 1))
    // backfill smartMode for settings saved before Phase 2c
    if (!parsed.smartMode) parsed.smartMode = defaults().smartMode
    if (!parsed.smartMode.proxy) parsed.smartMode.proxy = defaults().smartMode.proxy
    if (!Array.isArray(parsed.smartMode.platforms)) parsed.smartMode.platforms = ['all']
    return parsed
  } catch {
    return defaults()
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  next.maxConcurrent = Math.min(8, Math.max(1, Math.floor(next.maxConcurrent) || 1))
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  fs.mkdirSync(next.downloadDir, { recursive: true })
  return next
}
