/**
 * Persistent dashboard stats store (Phase 5 fix).
 * Accumulates stats INDEPENDENTLY of history — clearing history
 * never wipes dashboard data. This is the data the future cloud
 * dashboard will aggregate per-user.
 */
import * as path from 'node:path'
import { durableLoad, durableSave, storeFileExists } from './store-utils'

export interface DailyStat {
  count: number
  bytes: number
}

export interface StatsData {
  /** All-time totals */
  totalDownloads: number
  totalBytes: number
  successCount: number
  failCount: number
  videoBytes: number
  imageBytes: number
  /** Cumulative by platform */
  byPlatform: Record<string, { count: number; bytes: number }>
  /** Last 90 days, keyed YYYY-MM-DD */
  byDay: Record<string, DailyStat>
  /** Cumulative by creator name */
  byCreator: Record<string, number>
}

const empty = (): StatsData => ({
  totalDownloads: 0,
  totalBytes: 0,
  successCount: 0,
  failCount: 0,
  videoBytes: 0,
  imageBytes: 0,
  byPlatform: {},
  byDay: {},
  byCreator: {}
})

export class StatsStore {
  private file: string
  private data: StatsData
  private loadedOk = false
  /** Backup path data was restored from on load (null = main file was fine). */
  private restoredFrom: string | null = null
  /** True when main file AND all backups failed. */
  private loadFailed = false

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'stats.json')
    this.data = empty()
    this.load()
  }

  /** Health state for the UI banner. */
  status(): { loadedOk: boolean; restoredFrom: string | null; loadFailed: boolean } {
    return { loadedOk: this.loadedOk, restoredFrom: this.restoredFrom, loadFailed: this.loadFailed }
  }

  /**
   * User-initiated reset after a total load failure (stats file + all backups
   * unreadable). Stats are derived data — unlike prospects, they rebuild from
   * future downloads. The corrupt file is preserved via backup rotation on
   * this save, so nothing is silently destroyed.
   */
  reset(): void {
    this.data = empty()
    this.loadedOk = true
    this.loadFailed = false
    this.restoredFrom = null
    this.save()
  }

  private load(): void {
    const loaded = durableLoad<Partial<StatsData>>(this.file, (v): v is Partial<StatsData> => !!v && typeof v === 'object')
    if (loaded) {
      // Merge with empty to survive schema additions
      this.data = { ...empty(), ...loaded.data }
      this.loadedOk = true
      if (loaded.restoredFrom) {
        this.restoredFrom = loaded.restoredFrom
        console.warn(`[stats] restored from backup: ${loaded.restoredFrom}`)
        durableSave(this.file, JSON.stringify(this.data), false)
      }
    } else if (!storeFileExists(this.file)) {
      // Fresh install — safe to save later.
      this.loadedOk = true
    } else {
      // All copies unreadable — refuse saves (never wipe accumulated stats).
      console.error('[stats] load failed: main file and all backups unreadable')
      this.loadedOk = false
      this.loadFailed = true
    }
  }

  /** Durable save: fsync + rotating backups (never corrupts on crash). */
  private save(): void {
    if (!this.loadedOk) {
      console.error('[stats] refusing to save: initial load failed')
      return
    }
    // Prune byDay to last 90 days
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    for (const k of Object.keys(this.data.byDay)) {
      if (k < cutoffStr) delete this.data.byDay[k]
    }
    durableSave(this.file, JSON.stringify(this.data))
  }

  /**
   * Record a completed download. Called from the queue onFinished hook.
   * This is the SINGLE source of truth for dashboard numbers.
   */
  recordDownload(opts: {
    bytes: number
    platform: string
    creatorName?: string
    isImage: boolean
    success: boolean
  }): void {
    const d = this.data
    const today = new Date().toISOString().slice(0, 10)

    if (opts.success) {
      d.totalDownloads++
      d.successCount++
      d.totalBytes += opts.bytes
      if (opts.isImage) d.imageBytes += opts.bytes
      else d.videoBytes += opts.bytes

      const p = d.byPlatform[opts.platform] || { count: 0, bytes: 0 }
      p.count++
      p.bytes += opts.bytes
      d.byPlatform[opts.platform] = p

      const day = d.byDay[today] || { count: 0, bytes: 0 }
      day.count++
      day.bytes += opts.bytes
      d.byDay[today] = day

      if (opts.creatorName) {
        d.byCreator[opts.creatorName] = (d.byCreator[opts.creatorName] || 0) + 1
      }
    } else {
      d.failCount++
    }
    this.save()
  }

  get(): StatsData {
    return this.data
  }
}
