import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SmartModeConfig } from './settings'
import { platformForUrl } from './cookies'

const execFileAsync = promisify(execFile)

/** Platforms the user can route through the proxy. */
export const SMART_PLATFORMS = [
  'youtube',
  'tiktok',
  'x',
  'instagram',
  'snapchat',
  'pinterest'
] as const

export type SmartPlatform = (typeof SMART_PLATFORMS)[number]

/**
 * Build a proxy URL from config. Returns null when host is empty.
 * Format: http://user:pass@host:port (credentials URL-encoded).
 */
export function buildProxyUrl(cfg: SmartModeConfig): string | null {
  const host = cfg.proxy.host.trim()
  if (!host) return null
  const port = cfg.proxy.port > 0 && cfg.proxy.port < 65536 ? cfg.proxy.port : 8080
  const user = encodeURIComponent(cfg.proxy.username.trim())
  const pass = encodeURIComponent(cfg.proxy.password)
  const auth = user ? `${user}:${pass}@` : ''
  // strip any scheme the user pasted
  const cleanHost = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return `http://${auth}${cleanHost}:${port}`
}

/**
 * Should this URL go through the proxy?
 * Smart Mode must be enabled, a proxy configured, and the URL's platform
 * checked (or 'all').
 */
export function shouldUseProxy(rawUrl: string, cfg: SmartModeConfig): boolean {
  if (!cfg.enabled) return false
  if (!buildProxyUrl(cfg)) return false
  const platforms = cfg.platforms ?? []
  if (platforms.includes('all')) return true
  const platform = platformForUrl(rawUrl)
  if (!platform) return false
  // 'x' covers twitter.com too (platformForUrl maps both to 'x')
  return platforms.includes(platform)
}

export interface ProxyTestResult {
  ok: boolean
  /** Exit IP seen through the proxy (basic test). */
  ip?: string
  /** HTTP status (site test). */
  status?: number
  error?: string
}

async function runCurl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // curl ships with Windows 10+, macOS, and most Linux distros.
  return execFileAsync('curl', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
}

/**
 * Basic proxy test: fetch our exit IP through the proxy.
 * Success proves the proxy accepts connections and routes traffic.
 */
export async function testProxy(proxyUrl: string): Promise<ProxyTestResult> {
  try {
    const { stdout } = await runCurl([
      '-s', '-m', '20',
      '-x', proxyUrl,
      '-w', '\n%{http_code}',
      'https://api.ipify.org'
    ])
    const lines = stdout.trim().split('\n')
    const code = parseInt(lines.pop() ?? '', 10)
    const ip = (lines.pop() ?? '').trim()
    if (code === 200 && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return { ok: true, ip }
    }
    return { ok: false, error: `Unexpected response (HTTP ${code || '?'})` }
  } catch (err) {
    return { ok: false, error: curlError(err) }
  }
}

/**
 * Site test: fetch the user's URL through the proxy.
 * Tells the user whether that platform is reachable (not blocked)
 * on this proxy before they rely on it.
 */
export async function testSite(proxyUrl: string, siteUrl: string): Promise<ProxyTestResult> {
  const url = siteUrl.trim()
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Give a full URL starting with http(s)://' }
  }
  try {
    const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const { stdout } = await runCurl([
      '-s', '-m', '25', '-L', '--max-redirs', '3',
      '-x', proxyUrl,
      '-o', nullDev, '-w', '%{http_code}',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      url
    ])
    const code = parseInt(stdout.trim(), 10)
    if (code >= 200 && code < 400) {
      return { ok: true, status: code }
    }
    // 403/429/etc. through the proxy = likely blocked on this proxy
    return { ok: false, status: code, error: `Site returned HTTP ${code} via proxy — likely blocked` }
  } catch (err) {
    return { ok: false, error: curlError(err) }
  }
}

/** Translate common curl failures into plain language. */
function curlError(err: unknown): string {
  const e = err as { message?: string; stderr?: string; code?: number | string }
  // curl exit codes: 6 = couldn't resolve proxy/host, 7 = couldn't connect,
  // 28 = timeout, 56 = proxy closed connection, 97/… = proxy auth issues
  if (e.code === 6) return 'Host not found — check the proxy host/IP'
  if (e.code === 7) return 'Could not connect to proxy — check host/port'
  if (e.code === 28) return 'Proxy timed out — check host/port or firewall'
  if (e.code === 56) return 'Proxy closed the connection — it may need authentication'
  const msg = `${e.stderr ?? ''}\n${e.message ?? ''}`
  if (/could not resolve proxy/i.test(msg)) return 'Proxy host not found — check the host/IP'
  if (/connection refused|failed to connect/i.test(msg)) return 'Proxy refused the connection — check host/port'
  if (/timed out|timeout|timedout/i.test(msg)) return 'Proxy timed out — check host/port or firewall'
  if (/received http code 407|407 proxy/i.test(msg)) return 'Proxy needs authentication (407) — check username/password'
  if (/ENOENT.*curl|spawn curl ENOENT/i.test(msg)) return 'curl not found on this system'
  const firstLine = (e.stderr ?? e.message ?? 'Unknown error').split('\n')[0]
  return firstLine.length > 160 ? firstLine.slice(0, 160) + '…' : firstLine
}
