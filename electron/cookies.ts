import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface CookieProfile {
  platform: string
  /** base64(safeStorage.encryptString(netscape cookies.txt)) */
  encrypted: string
  addedAt: number
  expired: boolean
  lastTestedAt?: number
  lastTestOk?: boolean
}

/** Public view (no cookie values ever leave this module). */
export interface CookieProfileMeta {
  platform: string
  addedAt: number
  expired: boolean
  lastTestedAt?: number
  lastTestOk?: boolean
}

export const COOKIE_PLATFORMS = [
  'instagram',
  'tiktok',
  'youtube',
  'x',
  'facebook',
  'snapchat',
  'pinterest'
] as const

const DOMAIN_HINTS: Record<string, string[]> = {
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['x.com', 'twitter.com'],
  facebook: ['facebook.com'],
  snapchat: ['snapchat.com'],
  pinterest: ['pinterest.com']
}

/** Which cookie profile (if any) applies to a URL. */
export function platformForUrl(rawUrl: string): string | null {
  const u = rawUrl.toLowerCase()
  for (const [platform, domains] of Object.entries(DOMAIN_HINTS)) {
    if (domains.some((d) => u.includes(d))) return platform
  }
  return null
}

/** Error text smells like a login wall (vs. a dead link etc.). */
export function isLoginWallError(message: string): boolean {
  return /log ?in|sign ?in|401|unauthorized|empty media response|use --cookies|private|forbidden/i.test(message)
}

function vaultPath(): string {
  return path.join(app.getPath('userData'), 'cookie-vault.json')
}

function cookiesDir(): string {
  return path.join(app.getPath('userData'), 'cookies')
}

function ensureEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is not available — cannot store cookies securely on this machine')
  }
}

/**
 * Cookie vault. Values are encrypted with the OS keychain (safeStorage);
 * only metadata + ciphertext touch disk. The plaintext is materialized to
 * a per-platform file (mode 0o600) only while downloads need it.
 */
export class CookieVault {
  private profiles = new Map<string, CookieProfile>()

  constructor(private notify: (metas: CookieProfileMeta[]) => void) {
    this.load()
  }

  list(): CookieProfileMeta[] {
    return [...this.profiles.values()].map((p) => ({
      platform: p.platform,
      addedAt: p.addedAt,
      expired: p.expired,
      lastTestedAt: p.lastTestedAt,
      lastTestOk: p.lastTestOk
    }))
  }

  has(platform: string): boolean {
    return this.profiles.has(platform)
  }

  /**
   * Add/replace a profile. Validates Netscape format + at least one
   * non-expired cookie for the platform's domain (the "tested on add"
   * check — a live test is available via testProfile()).
   */
  add(platform: string, cookiesText: string): CookieProfileMeta {
    ensureEncryption()
    if (!COOKIE_PLATFORMS.includes(platform as (typeof COOKIE_PLATFORMS)[number])) {
      throw new Error(`Unknown platform: ${platform}`)
    }
    const now = Math.floor(Date.now() / 1000)
    const usable = countUsableCookies(cookiesText, platform, now)
    if (usable === 0) {
      throw new Error(
        `No usable cookies found for ${platform}. Paste a valid Netscape-format cookies.txt with at least one non-expired cookie for ${DOMAIN_HINTS[platform].join(', ')}.`
      )
    }
    const encrypted = safeStorage.encryptString(cookiesText).toString('base64')
    const profile: CookieProfile = {
      platform,
      encrypted,
      addedAt: Date.now(),
      expired: false
    }
    this.profiles.set(platform, profile)
    this.save()
    // drop any stale materialized file so the next download re-materializes
    try {
      fs.unlinkSync(this.materializedPath(platform))
    } catch {
      /* didn't exist */
    }
    const metas = this.list()
    this.notify(metas)
    return metas.find((m) => m.platform === platform)!
  }

  remove(platform: string): void {
    this.profiles.delete(platform)
    try {
      fs.unlinkSync(this.materializedPath(platform))
    } catch {
      /* didn't exist */
    }
    this.save()
    this.notify(this.list())
  }

  markExpired(platform: string): void {
    const p = this.profiles.get(platform)
    if (p && !p.expired) {
      p.expired = true
      this.save()
      this.notify(this.list())
    }
  }

  markTested(platform: string, ok: boolean): void {
    const p = this.profiles.get(platform)
    if (p) {
      p.lastTestedAt = Date.now()
      p.lastTestOk = ok
      if (ok) p.expired = false
      this.save()
      this.notify(this.list())
    }
  }

  private materializedPath(platform: string): string {
    return path.join(cookiesDir(), `${platform}.txt`)
  }

  /**
   * Decrypt + write the cookies file for a platform. Returns the path,
   * or null when there's no profile. The file is per-platform (shared by
   * concurrent jobs) and re-written on every call.
   */
  materialize(platform: string): string | null {
    const p = this.profiles.get(platform)
    if (!p) return null
    ensureEncryption()
    const plain = safeStorage.decryptString(Buffer.from(p.encrypted, 'base64'))
    const file = this.materializedPath(platform)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, plain, { mode: 0o600 })
    return file
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(vaultPath(), 'utf8')
      const data = JSON.parse(raw) as { profiles?: CookieProfile[] }
      for (const p of data.profiles ?? []) {
        if (p.platform && p.encrypted) this.profiles.set(p.platform, p)
      }
    } catch {
      /* no vault yet */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(vaultPath()), { recursive: true })
      const tmp = vaultPath() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ profiles: [...this.profiles.values()] }))
      fs.renameSync(tmp, vaultPath())
    } catch {
      /* persistence is best-effort */
    }
  }
}

/**
 * Count cookies that are (a) well-formed Netscape rows and (b) for the
 * platform's domain and (c) not expired. Session cookies (expiry 0)
 * count as usable.
 */
export function countUsableCookies(cookiesText: string, platform: string, nowSec: number): number {
  const domains = DOMAIN_HINTS[platform] ?? []
  let count = 0
  for (const rawLine of cookiesText.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const domain = parts[0].replace(/^\./, '').toLowerCase()
    if (!domains.some((d) => domain === d || domain.endsWith('.' + d))) continue
    const expiry = parseInt(parts[4], 10)
    if (Number.isFinite(expiry) && expiry !== 0 && expiry < nowSec) continue
    count++
  }
  return count
}
