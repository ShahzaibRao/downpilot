import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

export type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5'

export interface ProxyEntry {
  id: string
  /** User label, e.g. "Squid AWS". */
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  username: string
  password: string
}

export interface SmartModeConfig {
  enabled: boolean
  /** All saved proxies. */
  proxies: ProxyEntry[]
  /** ID of the active proxy (null = none selected). */
  activeProxyId: string | null
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
    proxies: [],
    activeProxyId: null,
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
    // migrate old single-proxy shape → proxies list
    const sm = parsed.smartMode as unknown as Record<string, unknown>
    if (sm && typeof sm === 'object' && 'proxy' in sm && !('proxies' in sm)) {
      const old = sm.proxy as { host?: string; port?: number; username?: string; password?: string }
      if (old?.host) {
        parsed.smartMode = {
          enabled: !!sm.enabled,
          proxies: [{
            id: 'proxy-' + Date.now().toString(36),
            name: 'My proxy',
            protocol: 'http',
            host: old.host ?? '',
            port: old.port ?? 8080,
            username: old.username ?? '',
            password: old.password ?? ''
          }],
          activeProxyId: null,
          platforms: Array.isArray(sm.platforms) ? (sm.platforms as string[]) : ['all']
        }
        const p = parsed.smartMode.proxies[0]
        parsed.smartMode.activeProxyId = p.id
      } else {
        parsed.smartMode = defaults().smartMode
      }
    }
    if (!Array.isArray(parsed.smartMode.proxies)) parsed.smartMode.proxies = []
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
