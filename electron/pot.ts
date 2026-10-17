import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { killTree } from './download/engine'

export const POT_PORT = 4416
export const POT_HOST = '127.0.0.1'
export const POT_VERSION = '2.0.2' // vendored bgutil-ytdlp-pot-provider version

function serverHome(): string {
  return path.join(app.getPath('userData'), 'pot-server')
}

function versionMarker(): string {
  return path.join(serverHome(), '.dp-version')
}

async function ping(): Promise<string | null> {
  try {
    const res = await fetch(`http://${POT_HOST}:${POT_PORT}/ping`, {
      signal: AbortSignal.timeout(3000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as { version?: string }
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

/**
 * Manages the Deno POT (Proof-of-Origin Token) server for YouTube.
 *
 * Lazy-start: the server only boots on the first YouTube download.
 * Health-checked via GET /ping; an already-running server on :4416 is
 * reused (port-conflict handling). Killed on app quit.
 */
export class PotManager {
  private proc: ChildProcess | null = null
  private starting: Promise<boolean> | null = null

  constructor(
    /** Vendored server source dir (repo in dev, resources in prod). */
    private sourceDir: string,
    /** Resolves the managed deno binary path. */
    private getDenoPath: () => Promise<string | null>,
    private log: (msg: string) => void = () => {}
  ) {}

  /** Plugin dir for yt-dlp --plugin-dirs (vendored, no install needed). */
  pluginDir(): string {
    // sibling of server source: pot/plugins
    return path.join(path.dirname(this.sourceDir), 'plugins')
  }

  /** Are the server files set up (copied + `deno install` done)? */
  filesReady(): boolean {
    try {
      const marker = fs.readFileSync(versionMarker(), 'utf8').trim()
      return marker === POT_VERSION && fs.existsSync(path.join(serverHome(), 'node_modules'))
    } catch {
      return false
    }
  }

  /**
   * Ensure a POT server is reachable. Starts ours if the port is free.
   * Returns true when yt-dlp should load the POT plugin.
   */
  async ensureRunning(): Promise<boolean> {
    // already up (ours or external)?
    const v = await ping()
    if (v) {
      this.log(`[pot] server already up on :${POT_PORT} (v${v}) — reusing`)
      return true
    }
    // single-flight start
    if (!this.starting) this.starting = this.start()
    const ok = await this.starting
    // reset single-flight so a later call retries after failure
    if (!ok) this.starting = null
    return ok
  }

  stop(): void {
    if (this.proc) {
      this.log('[pot] stopping server')
      killTree(this.proc)
      this.proc = null
    }
    this.starting = null
  }

  private async start(): Promise<boolean> {
    const denoPath = await this.getDenoPath()
    if (!denoPath) {
      this.log('[pot] deno not available — POT server disabled')
      return false
    }
    try {
      await this.ensureServerHome(denoPath)
    } catch (err) {
      this.log(`[pot] setup failed: ${(err as Error).message}`)
      return false
    }

    // port may have been taken while we were setting up
    const v = await ping()
    if (v) {
      this.log(`[pot] server appeared on :${POT_PORT} during setup (v${v}) — reusing`)
      return true
    }

    this.log('[pot] starting Deno server…')
    const proc = spawn(denoPath, ['run', '--allow-all', 'src/main.ts', '--port', String(POT_PORT), '--host', POT_HOST], {
      cwd: serverHome(),
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DENO_NO_UPDATE_CHECK: '1', DENO_NO_PROMPT: '1' }
    })
    proc.on('error', () => {
      this.log('[pot] server process error')
      if (this.proc === proc) this.proc = null
    })
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
    })
    this.proc = proc

    // wait for /ping (server needs a few seconds: npm deps load, etc.)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const version = await ping()
      if (version) {
        this.log(`[pot] server up on :${POT_PORT} (v${version})`)
        return true
      }
      if (this.proc === null) {
        this.log('[pot] server exited during startup')
        return false
      }
    }
    this.log('[pot] server did not answer /ping in time')
    return false
  }

  /** Copy vendored source + `deno install --frozen` (once per version). */
  private async ensureServerHome(denoPath: string): Promise<void> {
    const home = serverHome()
    let marker = ''
    try {
      marker = fs.readFileSync(versionMarker(), 'utf8').trim()
    } catch {
      /* not set up yet */
    }
    const needInstall = marker !== POT_VERSION || !fs.existsSync(path.join(home, 'node_modules'))
    if (!needInstall) return

    this.log('[pot] setting up server files (first run)…')
    if (!fs.existsSync(this.sourceDir)) {
      throw new Error(`POT server source not found: ${this.sourceDir}`)
    }
    copyDir(this.sourceDir, home)

    this.log('[pot] installing server dependencies (one-time, via Deno)…')
    await new Promise<void>((resolve, reject) => {
      const inst = spawn(denoPath, ['install', '--frozen'], {
        cwd: home,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, DENO_NO_UPDATE_CHECK: '1', DENO_NO_PROMPT: '1' }
      })
      inst.on('error', reject)
      inst.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`deno install exited with code ${code}`))
      })
    })
    fs.writeFileSync(versionMarker(), POT_VERSION)
    this.log('[pot] server setup complete')
  }
}
