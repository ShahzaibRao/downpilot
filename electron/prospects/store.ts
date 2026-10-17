import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type ProspectStatus = 'ok' | 'paused' | 'error'

export interface ProspectLink {
  id: string
  url: string
  platform: string
}

export interface Prospect {
  id: string
  name: string
  links: ProspectLink[]
  /** folder name under <downloadDir>/prospects/ */
  folder: string
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
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    this.load()
  }

  list(): Prospect[] {
    return this.prospects
  }

  get(id: string): Prospect | undefined {
    return this.prospects.find((p) => p.id === id)
  }

  add(url: string, name?: string): Prospect {
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

  unpause(id: string): void {
    const p = this.get(id)
    if (!p) return
    p.status = 'ok'
    p.failCount = 0
    p.lastError = null
    this.save()
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(prospectsFile(), 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) this.prospects = arr
    } catch {
      this.prospects = []
    }
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try {
        const file = prospectsFile()
        const tmp = file + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(this.prospects, null, 2))
        fs.renameSync(tmp, file)
      } catch {
        /* ignore */
      }
    }, 200)
  }
}
