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
  /** IDs of proxies in the rotation pool (round-robin). */
  selectedProxyIds: string[]
  /** Platforms that use the proxy: subset of SMART_PLATFORMS, or ['all']. */
  platforms: string[]
}

export interface Settings {
  downloadDir: string
  maxConcurrent: number
  /** max new items per prospect per check (default 20) */
  maxNewPerCheck: number
  smartMode: SmartModeConfig
  /** Appearance: light/dark/system */
  theme: 'light' | 'dark' | 'system'
  /** Accent color (hex) */
  accentColor: string
}

const defaults = (): Settings => ({
  downloadDir: path.join(app.getPath('downloads'), 'DownPilot'),
  maxConcurrent: 1,
  maxNewPerCheck: 20,
  smartMode: {
    enabled: false,
    proxies: [],
    selectedProxyIds: [],
    platforms: ['all']
  },
  theme: 'dark',
  accentColor: '#f97316'
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
    parsed.maxNewPerCheck = Math.min(50, Math.max(1, Math.floor(parsed.maxNewPerCheck) || 20))
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
    // migrate activeProxyId (single) → selectedProxyIds (rotation pool)
    const smm = parsed.smartMode as unknown as Record<string, unknown>
    if ('activeProxyId' in smm && !('selectedProxyIds' in smm)) {
      const oldId = smm.activeProxyId as string | null
      parsed.smartMode.selectedProxyIds = oldId ? [oldId] : []
      delete smm.activeProxyId
    }
    if (!Array.isArray(parsed.smartMode.selectedProxyIds)) parsed.smartMode.selectedProxyIds = []
    // drop selected IDs that no longer exist
    const ids = new Set((parsed.smartMode.proxies as ProxyEntry[]).map((p: ProxyEntry) => p.id))
    parsed.smartMode.selectedProxyIds = (parsed.smartMode.selectedProxyIds as string[]).filter((id: string) => ids.has(id))
    if (!Array.isArray(parsed.smartMode.platforms)) parsed.smartMode.platforms = ['all']
    return parsed
  } catch {
    return defaults()
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  next.maxConcurrent = Math.min(8, Math.max(1, Math.floor(next.maxConcurrent) || 1))
  next.maxNewPerCheck = Math.min(50, Math.max(1, Math.floor(next.maxNewPerCheck) || 20))
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  fs.mkdirSync(next.downloadDir, { recursive: true })
  return next
}
