import { DownloadJob, defaultScopeOpts, type Quality, type ProgressEvent, type Tools, type ScopeOpts, type CookieHooks, type PotHooks, type ProxyHooks } from './engine'
import { durableLoad, durableSave } from '../store-utils'

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed'

export interface Task extends ScopeOpts {
  id: string
  url: string
  quality: Quality
  status: TaskStatus
  engine: string
  filename: string
  percent: number
  downloaded: number
  total: number | null
  speed: string
  eta: string
  error?: string
  createdAt: number
  updatedAt: number
  /** Per-task output dir override (prospects). Defaults to global downloadDir. */
  outDir?: string
  /** Prospect tracking: which prospect/item this task belongs to. */
  prospectId?: string
  prospectItemId?: string
}

export interface NewTaskInput {
  url: string
  quality: Quality
  scopeOpts?: ScopeOpts
  outDir?: string
  prospectId?: string
  prospectItemId?: string
}

/** Normalize a URL for duplicate detection. */
export function normalizeUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/$/, '')
}

let idCounter = 0
function newId(): string {
  idCounter++
  return `t${Date.now().toString(36)}${idCounter.toString(36)}`
}

/**
 * Download queue.
 *
 * - Tasks flow: queued → running → done/failed; running → paused → queued.
 * - At most `maxConcurrent` jobs run at once (default 1).
 * - Pause kills the running job; resume re-runs it — yt-dlp picks up its
 *   .part files automatically, so nothing is re-downloaded.
 * - Tasks persist to a JSON file; on startup anything left 'running'
 *   goes back to 'queued' (the process died with them).
 *
 * Persistence is a JSON file, not SQLite: the queue is a small flat list
 * and this avoids native modules in dev. SQLite arrives with Prospect
 * mode (Phase 3), where relational queries earn their keep.
 */
export class QueueManager {
  private tasks = new Map<string, Task>()
  private jobs = new Map<string, DownloadJob>()
  private maxConcurrent: number

  constructor(
    private filePath: string,
    private getTools: () => Promise<Tools>,
    private getOutDir: () => string,
    private notify: (tasks: Task[]) => void,
    private onFinished?: (task: Task) => void,
    private cookies?: CookieHooks | null,
    private pot?: PotHooks | null,
    private proxy?: ProxyHooks | null
  ) {
    this.maxConcurrent = 1
    this.load()
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  add(url: string, quality: Quality, scopeOpts?: ScopeOpts, extra?: { outDir?: string; prospectId?: string; prospectItemId?: string }): Task {
    const now = Date.now()
    const so = { ...defaultScopeOpts(), ...scopeOpts }
    const task: Task = {
      id: newId(),
      url: url.trim(),
      quality,
      status: 'queued',
      engine: '',
      filename: '',
      percent: 0,
      downloaded: 0,
      total: null,
      speed: '',
      eta: '',
      createdAt: now,
      updatedAt: now,
      ...so,
      ...(extra?.outDir ? { outDir: extra.outDir } : {}),
      ...(extra?.prospectId ? { prospectId: extra.prospectId } : {}),
      ...(extra?.prospectItemId ? { prospectItemId: extra.prospectItemId } : {})
    }
    this.tasks.set(task.id, task)
    this.save()
    this.pump()
    this.notify(this.list())
    return task
  }

  /**
   * Bulk add: duplicates (within the batch or already in the queue) are
   * skipped. One save + one notify for the whole batch.
   */
  addMany(inputs: NewTaskInput[]): { added: number; skipped: number } {
    const existing = new Set([...this.tasks.values()].map((t) => normalizeUrl(t.url)))
    const seen = new Set<string>()
    let added = 0
    let skipped = 0
    const now = Date.now()
    for (const input of inputs) {
      const norm = normalizeUrl(input.url)
      if (!norm || seen.has(norm) || existing.has(norm)) {
        skipped++
        continue
      }
      seen.add(norm)
      const so = { ...defaultScopeOpts(), ...input.scopeOpts }
      const task: Task = {
        id: newId(),
        url: input.url.trim(),
        quality: input.quality,
        status: 'queued',
        engine: '',
        filename: '',
        percent: 0,
        downloaded: 0,
        total: null,
        speed: '',
        eta: '',
        createdAt: now,
        updatedAt: now,
        ...so,
        ...(input.outDir ? { outDir: input.outDir } : {}),
        ...(input.prospectId ? { prospectId: input.prospectId } : {}),
        ...(input.prospectItemId ? { prospectItemId: input.prospectItemId } : {})
      }
      this.tasks.set(task.id, task)
      added++
    }
    if (added > 0) {
      this.save()
      this.notify(this.list())
      this.pump()
    }
    return { added, skipped }
  }

  pause(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    console.log(`[queue] pause ${id} (status=${task.status})`)
    if (task.status === 'running') {
      this.jobs.get(id)?.cancel()
      this.jobs.delete(id)
    }
    if (task.status === 'running' || task.status === 'queued') {
      task.status = 'paused'
      task.updatedAt = Date.now()
      this.save()
      this.notify(this.list())
      this.pump()
    }
  }

  /**
   * Quit cleanup: kill ALL running download processes (yt-dlp/gallery-dl/ffmpeg
   * trees) so no orphan processes survive after the app closes. Tasks left
   * 'running' are re-queued on next startup (see load()).
   */
  shutdown(): void {
    if (this.jobs.size === 0) return
    console.log(`[queue] shutdown: killing ${this.jobs.size} running job(s)`)
    for (const [id, job] of this.jobs) {
      try {
        job.cancel()
      } catch {
        /* best-effort */
      }
      this.jobs.delete(id)
    }
    this.save()
  }

  resume(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status === 'paused' || task.status === 'failed') {
      task.status = 'queued'
      task.error = undefined
      task.updatedAt = Date.now()
      this.save()
      this.notify(this.list())
      this.pump()
    }
  }

  /** Retry is resume for failed tasks (clears the error). */
  retry(id: string): void {
    this.resume(id)
  }

  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    this.jobs.get(id)?.cancel()
    this.jobs.delete(id)
    this.tasks.delete(id)
    this.save()
    this.notify(this.list())
    this.pump()
  }

  clearDone(): void {
    let changed = false
    for (const [id, t] of this.tasks) {
      if (t.status === 'done' || t.status === 'failed') {
        this.tasks.delete(id)
        changed = true
      }
    }
    if (changed) {
      this.save()
      this.notify(this.list())
    }
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.min(8, Math.max(1, Math.floor(n) || 1))
    this.save()
    this.pump()
    this.notify(this.list())
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent
  }

  /** Start queued tasks while there's free capacity. */
  private pump(): void {
    if (this.jobs.size >= this.maxConcurrent) return
    const next = [...this.tasks.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    if (!next) return
    // Reserve the slot synchronously: startJob resolves tools async, and
    // without this two pumps could pick the same queued task twice.
    next.status = 'running'
    next.updatedAt = Date.now()
    this.save()
    this.notify(this.list())
    void this.startJob(next)
  }

  private async startJob(task: Task): Promise<void> {
    const tools = await this.getTools()
    const current = this.tasks.get(task.id)
    // paused/cancelled while tools resolved → don't start
    if (!current || current.status !== 'running') return
    if (this.jobs.size >= this.maxConcurrent) {
      // safety net: give the slot back
      current.status = 'queued'
      current.updatedAt = Date.now()
      this.save()
      this.notify(this.list())
      return
    }

    const job = new DownloadJob(
      task.id,
      task.url,
      task.outDir ?? this.getOutDir(),
      task.quality,
      tools,
      (e: ProgressEvent) => this.onJobEvent(task.id, e),
      { scope: task.scope, maxItems: task.maxItems, order: task.order, content: task.content ?? 'all' },
      this.cookies ?? null,
      this.pot ?? null,
      this.proxy ?? null
    )
    this.jobs.set(task.id, job)
    job.start()
  }

  private onJobEvent(id: string, e: ProgressEvent): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.engine = e.engine
    task.filename = e.filename || task.filename
    task.percent = e.percent
    task.downloaded = e.downloaded
    task.total = e.total
    task.speed = e.speed
    task.eta = e.eta
    task.updatedAt = Date.now()
    if (e.status === 'done' || e.status === 'error') {
      this.jobs.delete(id)
      task.status = e.status === 'done' ? 'done' : 'failed'
      task.error = e.error
      if (e.status === 'done') task.percent = 100
      this.onFinished?.(task)
    }
    this.save()
    this.notify(this.list())
    if (e.status === 'done' || e.status === 'error') this.pump()
  }

  private load(): void {
    const loaded = durableLoad<{ tasks?: Task[]; maxConcurrent?: number }>(
      this.filePath,
      (v): v is { tasks?: Task[]; maxConcurrent?: number } => !!v && typeof v === 'object'
    )
    if (!loaded) return // no queue file yet, or all copies unreadable (start empty)
    const data = loaded.data
    if (loaded.restoredFrom) {
      console.warn(`[queue] restored from backup: ${loaded.restoredFrom}`)
    }
    if (typeof data.maxConcurrent === 'number') {
      this.maxConcurrent = Math.min(8, Math.max(1, data.maxConcurrent))
    }
    for (const t of data.tasks ?? []) {
      if (!t.id || !t.url) continue
      // anything left 'running' died with the process → re-queue
      if (t.status === 'running') t.status = 'queued'
      // backfill fields added after the task was saved
      if (!t.scope) t.scope = 'single'
      if (typeof t.maxItems !== 'number') t.maxItems = 50
      if (!t.order) t.order = 'latest'
      if (!t.content) t.content = 'all'
      this.tasks.set(t.id, t)
    }
    if (loaded.restoredFrom) {
      // Write recovered data back to main (no rotation — corrupt main must
      // never enter the backup chain).
      durableSave(this.filePath, JSON.stringify({ tasks: [...this.tasks.values()], maxConcurrent: this.maxConcurrent }), false)
    }
  }

  private save(): void {
    durableSave(this.filePath, JSON.stringify({ tasks: [...this.tasks.values()], maxConcurrent: this.maxConcurrent }))
  }
}
