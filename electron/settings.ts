import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { durableLoad, durableSave } from './store-utils'

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

/** Tiny JSON settings store (durable: fsync + backups + fallback load). */
export function getSettings(): Settings {
  const loaded = durableLoad<Record<string, unknown>>(
    settingsPath(),
    (v): v is Record<string, unknown> => !!v && typeof v === 'object'
  )
  const raw: Record<string, unknown> = loaded ? (loaded.data as Record<string, unknown>) : {}
  if (loaded?.restoredFrom) {
    console.warn(`[settings] restored from backup: ${loaded.restoredFrom}`)
  }
  const parsed = { ...defaults(), ...raw }
    parsed.maxConcurrent = Math.min(8, Math.max(1, Math.floor(parsed.maxConcurrent) || 1))
    parsed.maxNewPerCheck = Math.min(50, Math.max(1, Math.floor(parsed.maxNewPerCheck) || 20))
    // backfill smartMode for settings saved before Phase 2c
    if (!parsed.smartMode) parsed.smartMode = defaults().smartMode
    // migrate old single-proxy shape → proxies list
    const sm = parsed.smartMode as unknown as Record<string, unknown>
    if (sm && typeof sm === 'object' && 'proxy' in sm && !('proxies' in sm)) {
      const old = sm.proxy as { host?: string; port?: number; username?: string; password?: string }
      if (old?.host) {
        const proxy = {
          id: 'proxy-' + Date.now().toString(36),
          name: 'My proxy',
          protocol: 'http' as const,
          host: old.host ?? '',
          port: old.port ?? 8080,
          username: old.username ?? '',
          password: old.password ?? ''
        }
        parsed.smartMode = {
          enabled: !!sm.enabled,
          proxies: [proxy],
          selectedProxyIds: [proxy.id],
          platforms: Array.isArray(sm.platforms) ? (sm.platforms as string[]) : ['all']
        }
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
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  next.maxConcurrent = Math.min(8, Math.max(1, Math.floor(next.maxConcurrent) || 1))
  next.maxNewPerCheck = Math.min(50, Math.max(1, Math.floor(next.maxNewPerCheck) || 20))
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  durableSave(settingsPath(), JSON.stringify(next, null, 2))
  fs.mkdirSync(next.downloadDir, { recursive: true })
  return next
}
