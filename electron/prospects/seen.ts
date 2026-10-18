import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

function seenFile(): string {
  return path.join(app.getPath('userData'), 'seen.json')
}

/**
 * Seen-tracking: which items we've already downloaded per prospect.
 * Key = `${prospectId}:${itemId}` → ISO timestamp.
 * Kept in memory as a Set for O(1) lookups; persisted as JSON.
 */
export class SeenStore {
  private seen = new Set<string>()

  constructor() {
    this.load()
  }

  private key(prospectId: string, itemId: string): string {
    return `${prospectId}:${itemId}`
  }

  has(prospectId: string, itemId: string): boolean {
    return this.seen.has(this.key(prospectId, itemId))
  }

  /** Mark items as seen. Returns how many were new. */
  markMany(prospectId: string, itemIds: string[]): number {
    let fresh = 0
    const now = new Date().toISOString()
    for (const id of itemIds) {
      const k = this.key(prospectId, id)
      if (!this.seen.has(k)) {
        this.seen.add(k)
        fresh++
      }
    }
    void now
    if (fresh > 0) this.save()
    return fresh
  }

  mark(prospectId: string, itemId: string): void {
    const k = this.key(prospectId, itemId)
    if (!this.seen.has(k)) {
      this.seen.add(k)
      this.save()
    }
  }

  /** Forget all seen items for a prospect (e.g. on prospect delete). */
  clearProspect(prospectId: string): void {
    const prefix = `${prospectId}:`
    let removed = false
    for (const k of [...this.seen]) {
      if (k.startsWith(prefix)) {
        this.seen.delete(k)
        removed = true
      }
    }
    if (removed) this.save()
  }

  count(): number {
    return this.seen.size
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(seenFile(), 'utf8')
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object') {
        for (const k of Object.keys(obj)) this.seen.add(k)
      }
    } catch {
      /* fresh */
    }
  }

  private save(): void {
    try {
      const obj: Record<string, 1> = {}
      for (const k of this.seen) obj[k] = 1
      const file = seenFile()
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj))
      fs.renameSync(tmp, file)
    } catch (e) {
      console.error(`[seen] save failed: ${(e as Error).message}`)
    }
  }
}
