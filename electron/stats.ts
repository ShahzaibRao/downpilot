/**
 * Dashboard stats aggregator (Phase 5).
 * Reads from the persistent StatsStore (NOT history) — clearing
 * history never wipes dashboard data. Live data (queue) is merged in.
 */
import type { HistoryStore } from './history'
import type { QueueManager } from './download/queue'
import type { ProspectStore } from './prospects/store'
import type { StatsStore } from './stats-store'

export interface DashboardStats {
  totalDownloads: number
  totalBytes: number
  successRate: number
  topSpeed: number // bytes/sec, session max
  byPlatform: { platform: string; count: number; bytes: number }[]
  last7Days: { date: string; count: number; bytes: number }[]
  topCreators: { name: string; count: number }[]
  videoBytes: number
  imageBytes: number
  recentActivity: {
    id: string
    text: string
    time: number
    kind: 'ok' | 'warn'
  }[]
  queue: {
    pending: number
    active: number
    failed: number
    etaSeconds: number | null
  }
  prospects: {
    watching: number
    paused: number
    error: number
  }
}

/** Derive platform from URL. */
export function platformFromUrl(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('tiktok.com')) return 'tiktok'
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('x.com') || u.includes('twitter.com')) return 'x'
  if (u.includes('snapchat.com') || u.includes('sc-cdn.net')) return 'snapchat'
  if (u.includes('pinterest.com')) return 'pinterest'
  if (u.includes('facebook.com') || u.includes('fb.')) return 'facebook'
  return 'other'
}

/** Guess if a file is video or image by extension. */
export function isImageFile(filename: string): boolean {
  return /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filename)
}

let sessionTopSpeed = 0
export function getSessionTopSpeed(): number {
  return sessionTopSpeed
}

export function computeStats(
  statsStore: StatsStore,
  history: HistoryStore,
  queue: QueueManager,
  prospects: ProspectStore
): DashboardStats {
  const s = statsStore.get()

  const total = s.successCount + s.failCount
  const successRate = total > 0 ? Math.round((s.successCount / total) * 100) : 100

  const byPlatform = Object.entries(s.byPlatform)
    .map(([platform, v]) => ({ platform, ...v }))
    .sort((a, b) => b.count - a.count)

  // Last 7 days (fill gaps with 0)
  const last7Days: { date: string; count: number; bytes: number }[] = []
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const day = s.byDay[key] || { count: 0, bytes: 0 }
    last7Days.push({ date: key, ...day })
  }

  const topCreators = Object.entries(s.byCreator)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  // Recent activity still comes from history (it's a feed, not stats)
  const entries = history.list()
  const recentActivity = entries.slice(0, 8).map((e) => ({
    id: e.id,
    text: e.status === 'done'
      ? `${e.filename.slice(0, 40)}${e.prospectName ? ` from @${e.prospectName}` : ''}`
      : `Failed: ${(e.error || 'unknown').slice(0, 50)}`,
    time: e.completedAt,
    kind: (e.status === 'done' ? 'ok' : 'warn') as 'ok' | 'warn'
  }))

  // Queue snapshot
  const tasks = queue.list()
  const pending = tasks.filter((t) => t.status === 'queued').length
  const active = tasks.filter((t) => t.status === 'running').length
  const failedQ = tasks.filter((t) => t.status === 'failed').length
  let etaSeconds: number | null = null
  if (active > 0 && pending > 0) {
    etaSeconds = Math.round((pending * 50 * 1024 * 1024) / (5 * 1024 * 1024))
  }

  // Prospect health
  const all = prospects.list()
  const watching = all.filter((p) => p.status === 'ok').length
  const paused = all.filter((p) => p.status === 'paused').length
  const error = all.filter((p) => p.status === 'error').length

  return {
    totalDownloads: s.totalDownloads,
    totalBytes: s.totalBytes,
    successRate,
    topSpeed: sessionTopSpeed,
    byPlatform,
    last7Days,
    topCreators,
    videoBytes: s.videoBytes,
    imageBytes: s.imageBytes,
    recentActivity,
    queue: { pending, active, failed: failedQ, etaSeconds },
    prospects: { watching, paused, error }
  }
}
