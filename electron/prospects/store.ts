import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Quality } from '../download/engine'

export type ProspectStatus = 'ok' | 'paused' | 'error'

export interface ProspectLink {
  id: string
  url: string
  platform: string
  /** Per-link status (Rao 2026-10-18): track each link independently. */
  linkStatus?: 'ok' | 'error' | 'paused'
  /** Consecutive failures; 3 → auto-pause this link (not the prospect). */
  linkFailCount?: number
  /** Last error message for this link. */
  linkLastError?: string | null
  /** Last successful check timestamp. */
  linkLastOk?: number | null
}

export interface Prospect {
  id: string
  name: string
  links: ProspectLink[]
  /** folder name under <downloadDir>/prospects/ */
  folder: string
  /** download quality for this prospect's content */
  quality: Quality
  /** minutes between auto-checks (CreatorWatch-style, default 60) */
  intervalMinutes: number
  status: ProspectStatus
  /** consecutive check failures; 3 → auto-pause */
  failCount: number
  lastCheck: string | null
  lastError: string | null
  createdAt: string
}

/** Derive a display name + platform from a profile URL. */
export function prospectNameFromUrl(rawUrl: string): { name: string; platform: string } {
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const segs = u.pathname.split('/').filter(Boolean)
    let platform = 'other'
    let name = segs[segs.length - 1] || host
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      platform = 'youtube'
      // /@handle, /c/name, /channel/id, /user/name
      const handle = segs.find((s) => s.startsWith('@'))
      name = handle ?? segs[segs.length - 1] ?? 'youtube'
    } else if (host.includes('tiktok.com')) {
      platform = 'tiktok'
      name = segs[1]?.startsWith('@') ? segs[1] : segs[segs.length - 1] ?? 'tiktok'
    } else if (host.includes('instagram.com')) {
      platform = 'instagram'
      name = segs[0] ?? 'instagram'
    } else if (host.includes('x.com') || host.includes('twitter.com')) {
      platform = 'x'
      name = segs[0] ?? 'x'
    } else if (host.includes('snapchat.com')) {
      platform = 'snapchat'
      name = segs[segs.length - 1] ?? 'snapchat'
    } else if (host.includes('pinterest.')) {
      platform = 'pinterest'
      name = segs[segs.length - 1] ?? 'pinterest'
    }
    name = decodeURIComponent(name).replace(/^@/, '').trim() || platform
    return { name, platform }
  } catch {
    return { name: rawUrl.slice(0, 32), platform: 'other' }
  }
}

/** Filesystem-safe folder name. */
export function safeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80) || 'prospect'
}

let counter = 0
function newId(prefix: string): string {
  counter++
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`
}

function prospectsFile(): string {
  return path.join(app.getPath('userData'), 'prospects.json')
}

/**
 * Prospect CRUD store. JSON file (atomic save), like the queue.
 * SQLite was considered; JSON avoids native modules and is plenty
 * for <1k prospects.
 */
export class ProspectStore {
  private prospects: Prospect[] = []
  /** true if load() read a valid file (or file didn't exist yet). If load failed
   *  on an existing file, we refuse to save — never overwrite good data with []. */
  private loadedOk = false

  constructor() {
    this.load()
  }

  list(): Prospect[] {
    return this.prospects
  }

  get(id: string): Prospect | undefined {
    return this.prospects.find((p) => p.id === id)
  }

  add(url: string, name?: string, quality?: Quality, intervalMinutes?: number): Prospect {
    const info = prospectNameFromUrl(url)
    const displayName = (name ?? info.name).trim() || info.name
    // unique folder: name, name-2, name-3…
    let folder = safeFolderName(displayName)
    const taken = new Set(this.prospects.map((p) => p.folder.toLowerCase()))
    let n = 2
    while (taken.has(folder.toLowerCase())) folder = `${safeFolderName(displayName)}-${n++}`
    const prospect: Prospect = {
      id: newId('p'),
      name: displayName,
      links: [{ id: newId('l'), url: url.trim(), platform: info.platform }],
      folder,
      quality: quality ?? 'best',
      intervalMinutes: Math.min(1440, Math.max(5, Math.floor(intervalMinutes ?? 60))),
      status: 'ok',
      failCount: 0,
      lastCheck: null,
      lastError: null,
      createdAt: new Date().toISOString()
    }
    this.prospects.unshift(prospect)
    this.save()
    return prospect
  }

  /** Add another platform link to an existing prospect (batch-add per creator). */
  addLink(prospectId: string, url: string): ProspectLink {
    const p = this.get(prospectId)
    if (!p) throw new Error('Prospect not found')
    const norm = url.trim().toLowerCase()
    if (p.links.some((l) => l.url.toLowerCase() === norm)) {
      throw new Error('This link is already added for this prospect')
    }
    const info = prospectNameFromUrl(url)
    const link: ProspectLink = { id: newId('l'), url: url.trim(), platform: info.platform }
    p.links.push(link)
    this.save()
    return link
  }

  removeLink(prospectId: string, linkId: string): void {
    const p = this.get(prospectId)
    if (!p) throw new Error('Prospect not found')
    if (p.links.length <= 1) throw new Error('A prospect needs at least one link')
    p.links = p.links.filter((l) => l.id !== linkId)
    this.save()
  }

  /** Update a link's URL (re-derives platform). */
  updateLink(prospectId: string, linkId: string, newUrl: string): ProspectLink {
    const p = this.get(prospectId)
    if (!p) throw new Error('Prospect not found')
    const link = p.links.find((l) => l.id === linkId)
    if (!link) throw new Error('Link not found')
    const trimmed = newUrl.trim()
    if (!/^https?:\/\//i.test(trimmed)) throw new Error('Enter a valid http(s) URL')
    const norm = trimmed.toLowerCase()
    if (p.links.some((l) => l.id !== linkId && l.url.toLowerCase() === norm)) {
      throw new Error('This URL is already added for this prospect')
    }
    const info = prospectNameFromUrl(trimmed)
    link.url = trimmed
    link.platform = info.platform
    this.save()
    return link
  }

  remove(id: string): void {
    this.prospects = this.prospects.filter((p) => p.id !== id)
    this.save()
  }

  rename(id: string, name: string): Prospect {
    const p = this.get(id)
    if (!p) throw new Error('Prospect not found')
    p.name = name.trim() || p.name
    this.save()
    return p
  }

  setQuality(id: string, quality: Quality): Prospect {
    const p = this.get(id)
    if (!p) throw new Error('Prospect not found')
    p.quality = quality
    this.save()
    return p
  }

  setInterval(id: string, minutes: number): Prospect {
    const p = this.get(id)
    if (!p) throw new Error('Prospect not found')
    p.intervalMinutes = Math.min(1440, Math.max(5, Math.floor(minutes) || 60))
    this.save()
    return p
  }

  setStatus(id: string, status: ProspectStatus, error?: string | null): void {
    const p = this.get(id)
    if (!p) return
    p.status = status
    if (status === 'ok') {
      p.failCount = 0
      p.lastError = null
    } else if (error !== undefined) {
      p.lastError = error
    }
    this.save()
  }

  /** Record a check outcome; 3 consecutive failures → auto-pause. */
  recordCheck(id: string, ok: boolean, error?: string, warning?: string): void {
    const p = this.get(id)
    if (!p) return
    p.lastCheck = new Date().toISOString()
    if (ok) {
      p.failCount = 0
      if (p.status !== 'paused') p.status = 'ok'
      // preserve per-link warnings (e.g. one platform flaky, others fine)
      p.lastError = warning ? `Warning: ${warning}` : null
    } else {
      p.failCount++
      p.lastError = error ?? 'Check failed'
      if (p.failCount >= 3) {
        p.status = 'paused'
      } else {
        p.status = 'error'
      }
    }
    this.save()
  }

  /**
   * Per-link check result (Rao 2026-10-18): track each platform link independently.
   * 3 consecutive fails → auto-pause THE LINK (not the prospect).
   */
  recordLinkCheck(prospectId: string, linkId: string, ok: boolean, error?: string): void {
    const p = this.get(prospectId)
    if (!p) return
    const link = p.links.find(l => l.id === linkId)
    if (!link) return
    if (ok) {
      link.linkStatus = 'ok'
      link.linkFailCount = 0
      link.linkLastError = null
      link.linkLastOk = Date.now()
    } else {
      link.linkFailCount = (link.linkFailCount || 0) + 1
      link.linkLastError = error || 'Check failed'
      if (link.linkFailCount >= 3) {
        link.linkStatus = 'paused'
      } else {
        link.linkStatus = 'error'
      }
    }
    this.save()
  }

  /** Manually unpause a link (reset fail count). */
  unpauseLink(prospectId: string, linkId: string): void {
    const p = this.get(prospectId)
    if (!p) return
    const link = p.links.find(l => l.id === linkId)
    if (!link) return
    link.linkStatus = 'ok'
    link.linkFailCount = 0
    link.linkLastError = null
    this.save()
  }

  unpause(id: string): void {
    const p = this.get(id)
    if (!p) return
    p.status = 'ok'
    p.failCount = 0
    p.lastError = null
    this.save()
  }

  private load(): void {
    const file = prospectsFile()
    try {
      const raw = fs.readFileSync(file, 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        this.prospects = arr
        // backfill for prospects saved before these fields existed
        for (const p of this.prospects) {
          if (!p.quality) p.quality = 'best'
          if (!p.intervalMinutes) p.intervalMinutes = 60
        }
        this.loadedOk = true
      } else {
        console.error(`[prospects] not an array: ${file}`)
      }
    } catch (e) {
      if (fs.existsSync(file)) {
        // File exists but unreadable — DO NOT wipe it. Keep prospects empty
        // in memory but refuse to save until user adds something.
        console.error(`[prospects] load failed (keeping file untouched): ${(e as Error).message}`)
      } else {
        // Fresh start — no file yet, safe to save later.
        this.loadedOk = true
      }
      this.prospects = []
    }
  }

  private save(): void {
    // Never overwrite a file we failed to load — protects against wipe.
    if (!this.loadedOk) {
      console.error('[prospects] refusing to save: initial load failed')
      return
    }
    try {
      const file = prospectsFile()
      const tmp = file + '.tmp'
      const data = JSON.stringify(this.prospects, null, 2)
      // Keep one backup of the previous good file (recovery from corruption).
      try {
        if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
      } catch { /* backup best-effort */ }
      fs.writeFileSync(tmp, data)
      fs.renameSync(tmp, file)
    } catch (e) {
      console.error(`[prospects] save failed: ${(e as Error).message}`)
    }
  }

  /** Call on app quit — no-op now (saves are synchronous). Kept for API compat. */
  flush(): void { /* synchronous saves need no flush */ }
}
