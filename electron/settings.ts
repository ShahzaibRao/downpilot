import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

export interface Settings {
  downloadDir: string
  maxConcurrent: number
}

const defaults = (): Settings => ({
  downloadDir: path.join(app.getPath('downloads'), 'DownPilot'),
  maxConcurrent: 1
})

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** Tiny JSON settings store. */
export function getSettings(): Settings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = { ...defaults(), ...JSON.parse(raw) }
    parsed.maxConcurrent = Math.min(8, Math.max(1, Math.floor(parsed.maxConcurrent) || 1))
    return parsed
  } catch {
    return defaults()
  }
}

export function setSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  next.maxConcurrent = Math.min(8, Math.max(1, Math.floor(next.maxConcurrent) || 1))
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  fs.mkdirSync(next.downloadDir, { recursive: true })
  return next
}
