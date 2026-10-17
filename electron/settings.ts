import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

export interface Settings {
  downloadDir: string
}

const defaults = (): Settings => ({
  downloadDir: path.join(app.getPath('downloads'), 'DownPilot')
})

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** Tiny JSON settings store. (SQLite comes with the queue in P1c.) */
export function getSettings(): Settings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    return { ...defaults(), ...JSON.parse(raw) }
  } catch {
    return defaults()
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  fs.mkdirSync(next.downloadDir, { recursive: true })
  return next
}
