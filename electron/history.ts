import fs from 'node:fs'
import path from 'node:path'
import type { Quality } from './download/engine'

export interface HistoryEntry {
  id: string
  url: string
  filename: string
  engine: string
  quality: Quality
  status: 'done' | 'failed'
  error?: string
  downloaded: number
  completedAt: number
}

const MAX_ENTRIES = 100

/**
 * Download history: last 100 finished tasks (done + failed).
 * Separate from the queue — clearing finished queue tasks doesn't
 * erase history.
 */
export class HistoryStore {
  private entries: HistoryEntry[] = []

  constructor(
    private filePath: string,
    private notify: (entries: HistoryEntry[]) => void
  ) {
    this.load()
  }

  list(): HistoryEntry[] {
    return [...this.entries]
  }

  add(entry: HistoryEntry): void {
    // replace any existing entry for the same task id (re-downloads)
    this.entries = this.entries.filter((e) => e.id !== entry.id)
    this.entries.unshift(entry)
    this.entries = this.entries.slice(0, MAX_ENTRIES)
    this.save()
    this.notify(this.list())
  }

  clear(): void {
    this.entries = []
    this.save()
    this.notify(this.list())
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const data = JSON.parse(raw) as { entries?: HistoryEntry[] }
      this.entries = (data.entries ?? []).filter((e) => e.id && e.url).slice(0, MAX_ENTRIES)
    } catch {
      /* no history file yet */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = this.filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }))
      fs.renameSync(tmp, this.filePath)
    } catch {
      /* persistence is best-effort */
    }
  }
}
