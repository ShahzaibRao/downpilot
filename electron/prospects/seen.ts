import { app } from 'electron'
import path from 'node:path'
import { durableLoad, durableSave, storeFileExists } from '../store-utils'

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

  /** Forget a single item (e.g. download failed → retry next check). */
  unmark(prospectId: string, itemId: string): void {
    const k = this.key(prospectId, itemId)
    if (this.seen.delete(k)) this.save()
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

  /** Bulk-add seen keys (import: keys already in `${prospectId}:${itemId}` form). */
  importKeys(keys: string[]): number {
    let fresh = 0
    for (const k of keys) {
      if (k && !this.seen.has(k)) {
        this.seen.add(k)
        fresh++
      }
    }
    if (fresh > 0) this.save()
    return fresh
  }

  /** All seen keys (export: grouped by prospect on the caller side). */
  allKeys(): string[] {
    return [...this.seen]
  }

  count(): number {
    return this.seen.size
  }

  private load(): void {
    const loaded = durableLoad<Record<string, unknown>>(seenFile(), (v): v is Record<string, unknown> => !!v && typeof v === 'object')
    if (loaded) {
      for (const k of Object.keys(loaded.data)) this.seen.add(k)
      if (loaded.restoredFrom) {
        console.warn(`[seen] restored from backup: ${loaded.restoredFrom}`)
        const obj: Record<string, 1> = {}
        for (const k of this.seen) obj[k] = 1
        durableSave(seenFile(), JSON.stringify(obj), false)
      }
    } else if (!storeFileExists(seenFile())) {
      /* fresh — nothing to load */
    } else {
      console.error('[seen] load failed: main file and all backups unreadable (starting empty)')
    }
  }

  private save(): void {
    const obj: Record<string, 1> = {}
    for (const k of this.seen) obj[k] = 1
    durableSave(seenFile(), JSON.stringify(obj))
  }
}
