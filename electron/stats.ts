/**
 * Dashboard stats aggregator (Phase 5).
 * Computes all dashboard metrics from history, queue, and prospects.
 */
import type { HistoryStore } from './history'
import type { QueueManager } from './download/queue'
import type { ProspectStore } from './prospects/store'

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
function isImageFile(filename: string): boolean {
  return /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filename)
}

let sessionTopSpeed = 0
export function getSessionTopSpeed(): number {
  return sessionTopSpeed
}

export function computeStats(
  history: HistoryStore,
  queue: QueueManager,
  prospects: ProspectStore
): DashboardStats {
  const entries = history.list()
  const done = entries.filter((e) => e.status === 'done')

  const totalBytes = done.reduce((s, e) => s + (e.downloaded || 0), 0)
  const failed = entries.filter((e) => e.status === 'failed').length
  const successRate = entries.length > 0
    ? Math.round((done.length / entries.length) * 100)
    : 100

  // By platform
  const platMap = new Map<string, { count: number; bytes: number }>()
  for (const e of done) {
    const p = platformFromUrl(e.url)
    const cur = platMap.get(p) || { count: 0, bytes: 0 }
    cur.count++
    cur.bytes += e.downloaded || 0
    platMap.set(p, cur)
  }
  const byPlatform = [...platMap.entries()]
    .map(([platform, v]) => ({ platform, ...v }))
    .sort((a, b) => b.count - a.count)

  // Last 7 days
  const dayMap = new Map<string, { count: number; bytes: number }>()
  const now = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    dayMap.set(key, { count: 0, bytes: 0 })
  }
  for (const e of done) {
    const key = new Date(e.completedAt).toISOString().slice(0, 10)
    const cur = dayMap.get(key)
    if (cur) {
      cur.count++
      cur.bytes += e.downloaded || 0
    }
  }
  const last7Days = [...dayMap.entries()].map(([date, v]) => ({ date, ...v }))

  // Top creators (prospect downloads)
  const creatorMap = new Map<string, number>()
  for (const e of done) {
    if (e.prospectName) {
      creatorMap.set(e.prospectName, (creatorMap.get(e.prospectName) || 0) + 1)
    }
  }
  const topCreators = [...creatorMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  // Video vs image bytes
  let videoBytes = 0
  let imageBytes = 0
  for (const e of done) {
    if (isImageFile(e.filename)) imageBytes += e.downloaded || 0
    else videoBytes += e.downloaded || 0
  }

  // Recent activity (last 8)
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
  // Rough ETA: sum remaining bytes / current speed (if any active)
  let etaSeconds: number | null = null
  const activeTasks = tasks.filter((t) => t.status === 'running')
  if (activeTasks.length > 0 && pending > 0) {
    // Very rough: assume average 5 MB/s per task
    etaSeconds = Math.round((pending * 50 * 1024 * 1024) / (5 * 1024 * 1024))
  }

  // Prospect health
  const all = prospects.list()
  const watching = all.filter((p) => p.status === 'ok').length
  const paused = all.filter((p) => p.status === 'paused').length
  const error = all.filter((p) => p.status === 'error').length

  return {
    totalDownloads: done.length,
    totalBytes,
    successRate,
    topSpeed: sessionTopSpeed,
    byPlatform,
    last7Days,
    topCreators,
    videoBytes,
    imageBytes,
    recentActivity,
    queue: { pending, active, failed: failedQ, etaSeconds },
    prospects: { watching, paused, error }
  }
}
