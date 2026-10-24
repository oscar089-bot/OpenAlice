/**
 * Owns the tv-feed child process.
 *
 * The feed is a separate Node service (`services/tv-feed`), not an import. Alice
 * spawns it when `tvFeed.enabled` and `tvFeed.autoStart` are both true, so
 * `pnpm dev`, `pnpm start`, and packaged Electron all get the same behavior from
 * one implementation instead of three launcher-specific copies.
 *
 * Supervision is deliberately shallow: restart on unexpected exit with backoff,
 * and never make Alice's own boot depend on the feed coming up. `TvFeedClient`
 * already reconnects, and watchers already fall back to the bar layer, so a
 * permanently broken service degrades to "delayed data", not "no Alice".
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { appResourcesHome } from '../../../core/paths.js'
import type { Logger } from '../../../workspaces/logger.js'
import type { TvFeedConfig } from '../../../core/config.js'

/** Restart backoff bounds for an exiting child. */
const RESTART_BASE_MS = 2_000
const RESTART_MAX_MS = 60_000

/** Extract the port the service must bind from the configured WebSocket URL. */
export function portFromFeedUrl(url: string): number | null {
  try {
    const parsed = new URL(url)
    if (parsed.port) {
      const port = Number.parseInt(parsed.port, 10)
      return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null
    }
    // ws:// has a default port, but the service needs an explicit bind value.
    return parsed.protocol === 'wss:' ? 443 : 80
  } catch {
    return null
  }
}

/**
 * Locate the built entry point.
 *
 * Dev runs from the repo (`<cwd>/services/tv-feed/dist/main.js`); a packaged
 * build ships the service under app resources. Absent means the operator has
 * not run `npm install && npm run build` there yet — a normal first-run state,
 * not an error.
 */
export function resolveFeedEntry(): string | null {
  const candidates = [
    resolve(appResourcesHome, 'services', 'tv-feed', 'dist', 'main.js'),
    resolve(process.cwd(), 'services', 'tv-feed', 'dist', 'main.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Spawn and supervise the TradingView feed service.
 *
 * Inert unless {@link start} is called. Every failure is logged and swallowed;
 * this class never throws into Alice's boot path.
 */
export class TvFeedSupervisor {
  private child: ChildProcess | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = false

  constructor(
    private readonly config: TvFeedConfig,
    private readonly logger: Logger,
  ) {}

  /** True while a child process is alive. */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  /** Start the service. Safe to call once; returns immediately if inert. */
  start(): void {
    if (this.stopped || !this.config.enabled || !this.config.autoStart) return

    const entry = resolveFeedEntry()
    if (!entry) {
      this.logger.warn('tv_feed.entry_missing', {
        hint: 'Run `cd services/tv-feed && npm install && npm run build` to enable the live feed.',
      })
      return
    }

    const port = portFromFeedUrl(this.config.url)
    if (port === null) {
      this.logger.warn('tv_feed.invalid_url', { url: this.config.url })
      return
    }

    this.spawnChild(entry, port)
  }

  private spawnChild(entry: string, port: number): void {
    let child: ChildProcess
    try {
      child = spawn(process.execPath, [entry], {
        cwd: resolve(entry, '..', '..'),
        env: {
          ...process.env,
          WEBSOCKET_PORT: String(port),
          // Without this the service binds every interface by default. Passing
          // it explicitly keeps the loopback default deliberate.
          WEBSOCKET_HOST: this.config.bindHost,
          // Alice drives subscriptions on demand, so the service needs no
          // startup list. Leaving it empty also avoids a second subscriber.
          SUBSCRIPTIONS: process.env['OPENALICE_TV_FEED_SUBSCRIPTIONS'] ?? '[]',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detach so a guardian shutdown of Alice does not orphan the port.
        detached: false,
      })
    } catch (err) {
      this.logger.warn('tv_feed.spawn_failed', { err: String(err) })
      return
    }

    this.child = child
    this.attempts = 0
    this.logger.info('tv_feed.started', { pid: child.pid, port })

    // Surface the service's own diagnostics through Alice's log rather than
    // letting them write directly to the parent's stdout.
    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) this.logger.debug('tv_feed.stdout', { line })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) this.logger.warn('tv_feed.stderr', { line })
    })

    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      this.logger.warn('tv_feed.exited', { code, signal })
      this.scheduleRestart(entry, port)
    })

    child.on('error', (err) => {
      this.logger.warn('tv_feed.child_error', { err: err.message })
    })
  }

  private scheduleRestart(entry: string, port: number): void {
    if (this.restartTimer) return
    const delay = Math.min(RESTART_BASE_MS * 2 ** Math.min(this.attempts, 5), RESTART_MAX_MS)
    this.attempts++
    this.logger.info('tv_feed.restart_scheduled', { delayMs: delay, attempt: this.attempts })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopped) return
      this.spawnChild(entry, port)
    }, delay)
    this.restartTimer.unref?.()
  }

  /** Stop the child and cancel any pending restart. Idempotent. */
  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    if (!child) return
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}
