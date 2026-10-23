/**
 * Durable JSON store helpers — the fix for the 2026-10-23 prospects wipe.
 *
 * Root causes found:
 * 1. Saves were never fsynced — data sat in the Windows file cache and was
 *    lost on power loss, leaving a correct-size file full of zeros.
 * 2. The single .bak backup was written but NEVER read back on load failure —
 *    the app showed an empty list while good data sat on disk.
 * 3. After a failed load the app silently refused all saves (dead-end state).
 *
 * Protocol:
 * - Save: rotate backups (3 generations) → write tmp → fsync → rename.
 *   fsync forces data to physical disk, so a power cut cannot zero the file.
 * - Load: try main → .bak1 → .bak2 → .bak3 → .bak (legacy) and report
 *   which source was used, so the UI can warn instead of silently emptying.
 * - Restore saves (writing back recovered data) skip rotation, so a corrupt
 *   main file never propagates into the backup chain.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const BACKUP_COUNT = 3

function backupPaths(file: string): string[] {
  const out: string[] = []
  for (let i = 1; i <= BACKUP_COUNT; i++) out.push(`${file}.bak${i}`)
  out.push(`${file}.bak`) // legacy single-backup name
  return out
}

/**
 * Durably write `data` to `file`.
 * @param rotate — shift backups first (default true). Pass false when writing
 *   back recovered data, so a corrupt main file never enters the backup chain.
 * @returns true on success.
 */
export function durableSave(file: string, data: string, rotate = true): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (rotate) {
      try {
        const [bak1, bak2, bak3] = backupPaths(file)
        if (fs.existsSync(bak2)) {
          try { fs.copyFileSync(bak2, bak3) } catch { /* best-effort */ }
        }
        if (fs.existsSync(bak1)) {
          try { fs.copyFileSync(bak1, bak2) } catch { /* best-effort */ }
        }
        if (fs.existsSync(file)) {
          try { fs.copyFileSync(file, bak1) } catch { /* best-effort */ }
        }
        // Keep the legacy .bak name in sync for older builds / manual recovery.
        if (fs.existsSync(file)) {
          try { fs.copyFileSync(file, `${file}.bak`) } catch { /* best-effort */ }
        }
      } catch { /* backup rotation is best-effort */ }
    }
    // Write tmp + fsync (force to physical disk) + atomic rename.
    const tmp = `${file}.tmp`
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    console.error(`[store] durable save failed for ${file}: ${(e as Error).message}`)
    return false
  }
}

export interface LoadedData<T> {
  data: T
  /** null = loaded from main file; otherwise the backup path it came from. */
  restoredFrom: string | null
}

/**
 * Load JSON from `file`, falling back through backups on any failure
 * (missing file, unreadable file, invalid JSON, failed validation).
 * @returns parsed data + source, or null if every candidate failed.
 */
export function durableLoad<T>(
  file: string,
  validate: (v: unknown) => v is T
): LoadedData<T> | null {
  const candidates = [file, ...backupPaths(file)]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const raw = fs.readFileSync(candidate, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (validate(parsed)) {
        return { data: parsed, restoredFrom: candidate === file ? null : candidate }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/** True when a store file exists on disk (used to tell "fresh install" apart from "all copies corrupt"). */
export function storeFileExists(file: string): boolean {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}
