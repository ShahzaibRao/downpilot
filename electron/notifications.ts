import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface AppNotification {
  id: string
  title: string
  body: string
  /** prospect this relates to (click → opens folder) */
  prospectId?: string
  prospectName?: string
  createdAt: number
  read: boolean
}

function notifyFile(): string {
  return path.join(app.getPath('userData'), 'notifications.json')
}

let counter = 0
function newId(): string {
  counter++
  return `n${Date.now().toString(36)}${counter.toString(36)}`
}

const MAX_NOTIFICATIONS = 50

/**
 * In-app notifications (bell). Persisted JSON, newest first.
 * Native desktop notifications are sent separately via Electron.
 */
export class NotificationStore {
  private items: AppNotification[] = []

  constructor() {
    this.load()
  }

  list(): AppNotification[] {
    return this.items
  }

  unreadCount(): number {
    return this.items.filter((n) => !n.read).length
  }

  add(title: string, body: string, prospectId?: string, prospectName?: string): AppNotification {
    const n: AppNotification = {
      id: newId(),
      title,
      body,
      createdAt: Date.now(),
      read: false,
      ...(prospectId ? { prospectId } : {}),
      ...(prospectName ? { prospectName } : {})
    }
    this.items.unshift(n)
    if (this.items.length > MAX_NOTIFICATIONS) {
      this.items = this.items.slice(0, MAX_NOTIFICATIONS)
    }
    this.save()
    return n
  }

  markRead(id: string): void {
    const n = this.items.find((x) => x.id === id)
    if (n && !n.read) {
      n.read = true
      this.save()
    }
  }

  markAllRead(): void {
    let changed = false
    for (const n of this.items) {
      if (!n.read) {
        n.read = true
        changed = true
      }
    }
    if (changed) this.save()
  }

  clear(): void {
    if (this.items.length > 0) {
      this.items = []
      this.save()
    }
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(notifyFile(), 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) this.items = arr
    } catch {
      this.items = []
    }
  }

  private save(): void {
    try {
      const file = notifyFile()
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2))
      fs.renameSync(tmp, file)
    } catch (e) {
      console.error(`[notify] save failed: ${(e as Error).message}`)
    }
  }
}
