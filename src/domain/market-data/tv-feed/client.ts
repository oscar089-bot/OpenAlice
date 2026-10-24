import WebSocket from 'ws'
import type { Logger } from '../../../workspaces/logger.js'
import type { TvFeedConfig } from '../../../core/config.js'
import { tvTimeframe } from './symbol-map.js'
import type { CachedTvBar, TvFeedBar, TvLiveQuote } from './types.js'

/** Key for the cache: one entry per ticker+resolution. */
function cacheKey(ticker: string, timeframe: string): string {
  return `${ticker}_${timeframe}`
}

/** Reconnect backoff bounds. The feed is optional, so failures stay quiet. */
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

/**
 * Live TradingView quote cache.
 *
 * Deliberately small: the heavy lifting (socket lifecycle to TradingView,
 * reconnect, backfill, stale detection) lives in the tv-feed service. Alice
 * only needs the most recent forming candle per subscribed pair so a watcher
 * tick can price a pair instantly instead of waiting on a delayed vendor.
 *
 * Fail-soft by construction. Every public method returns null/void rather than
 * throwing, and a disconnected client simply reports no quote — the watcher
 * then falls back to the federated bar layer, which is exactly today's
 * behaviour.
 *
 * Not a plugin: it has no EngineContext dependency, so the workspace service can
 * own one instance without a process-wide lifecycle.
 */
export class TvFeedClient {
  private ws: WebSocket | null = null
  private readonly cache = new Map<string, CachedTvBar>()
  /** Latest FINAL candle per series, kept separately from the forming one. */
  private readonly closedBars = new Map<string, CachedTvBar>()
  /** What we want subscribed, so a reconnect can restore it. */
  private readonly desired = new Map<string, { ticker: string; timeframe: string }>()
  /** Pending waiters: key -> resolvers waiting for the first bar. */
  private readonly waiters = new Map<string, Array<() => void>>()
  /** Callers waiting for the socket to finish opening. */
  private readonly openWaiters: Array<(ok: boolean) => void> = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private stopped = false
  private connected = false

  constructor(
    private readonly config: TvFeedConfig,
    private readonly logger: Logger,
  ) {}

  /** True once the socket is open and the service acknowledged us. */
  get isConnected(): boolean {
    return this.connected
  }

  /**
   * Open the socket. Safe to call repeatedly; only one connection is kept.
   * Never rejects — a failure schedules a reconnect instead.
   */
  connect(): void {
    if (this.stopped || this.ws) return
    this.openSocket()
  }

  private openSocket(): void {
    let socket: WebSocket
    try {
      socket = new WebSocket(this.config.url, { handshakeTimeout: 5_000 })
    } catch (err) {
      this.logger.warn('tv_feed.socket_create_failed', { err: String(err) })
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    socket.on('open', () => {
      this.connected = true
      this.reconnectAttempts = 0
      this.logger.info('tv_feed.connected', { url: this.config.url })
      this.resubscribeAll()
      this.flushOpenWaiters(true)
    })

    socket.on('message', (raw) => {
      this.handleMessage(raw)
    })

    socket.on('error', (err) => {
      // 'close' always follows, so recovery lives there.
      this.logger.warn('tv_feed.socket_error', { err: err.message })
    })

    socket.on('close', () => {
      this.connected = false
      if (this.ws === socket) this.ws = null
      this.flushOpenWaiters(false)
      if (this.stopped) return
      this.logger.warn('tv_feed.disconnected')
      this.scheduleReconnect()
    })
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: unknown
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const record = msg as Record<string, unknown>

    if (record['type'] === 'bar' && record['bar']) {
      this.acceptBar(record['bar'] as TvFeedBar)
      return
    }
    if (record['type'] === 'error') {
      this.logger.warn('tv_feed.server_error', { message: record['message'] })
    }
  }

  /** Store the newest forming candle and wake any waiter for that pair. */
  private acceptBar(bar: TvFeedBar): void {
    if (
      typeof bar.symbol !== 'string' || typeof bar.timeframe !== 'string' ||
      typeof bar.time !== 'number' || typeof bar.close !== 'number'
    ) {
      return
    }
    const key = cacheKey(bar.symbol, bar.timeframe)

    // A CLOSED candle is kept in its own slot, never compared against the
    // forming one. On a period rollover the service broadcasts the NEW forming
    // candle first and the closed candle right after, so treating them as one
    // series would drop the close as "out of order" and a `candle_close` rule
    // would never see a confirmed bar.
    if (bar.closed === true) {
      const closed = this.closedBars.get(key)
      if (closed && bar.time < closed.bar.time) return
      this.closedBars.set(key, { bar, receivedAt: Date.now() })
      // Same-period forming entry: upgrade it so the tail does not keep
      // advertising a candle that has already finalised.
      const forming = this.cache.get(key)
      if (forming && forming.bar.time === bar.time) this.cache.delete(key)
      this.wakeWaiters(key)
      return
    }

    const existing = this.cache.get(key)
    // Ignore an out-of-order tick for an older candle: the service can replay
    // history after a reconnect, and regressing the cache would make a watcher
    // evaluate a stale price.
    if (existing && bar.time < existing.bar.time) return

    this.cache.set(key, { bar, receivedAt: Date.now() })
    this.wakeWaiters(key)
  }

  private wakeWaiters(key: string): void {
    const waiting = this.waiters.get(key)
    if (!waiting) return
    this.waiters.delete(key)
    for (const resolve of waiting) resolve()
  }

  private resubscribeAll(): void {
    for (const { ticker, timeframe } of this.desired.values()) {
      this.send({ action: 'subscribe', symbol: ticker, timeframe })
    }
  }

  /** Resolve every caller waiting on the socket opening. */
  private flushOpenWaiters(ok: boolean): void {
    const waiting = this.openWaiters.splice(0)
    for (const resolve of waiting) resolve(ok)
  }

  /**
   * Wait for the socket to open, bounded by `subscribeTimeoutMs`.
   *
   * The first watcher tick after boot always lands before the socket is up, so
   * failing immediately would guarantee one wasted tick per pair. Waiting keeps
   * the semantics "quote or null" without a warm-up dance at the call site.
   */
  private waitForOpen(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const onOpen = (ok: boolean) => {
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => {
        const idx = this.openWaiters.indexOf(onOpen)
        if (idx >= 0) this.openWaiters.splice(idx, 1)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.openWaiters.push(onOpen)
    })
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.ws || !this.connected) return
    try {
      this.ws.send(JSON.stringify(payload))
    } catch (err) {
      this.logger.warn('tv_feed.send_failed', { err: String(err) })
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 5),
      RECONNECT_MAX_MS,
    )
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  /**
   * Price one pair from the live feed.
   *
   * Subscribes on demand, then waits up to `subscribeTimeoutMs` for the first
   * bar. Returns null when the feed is off, the interval is unsupported, the
   * symbol cannot be expressed as a TV ticker, or the data is stale — every one
   * of those is a normal fall-back signal, not an error.
   *
   * `assetClass` is the BAR-layer class (`crypto` | `currency`), matching
   * `toBarAssetClass()`.
   */
  async getQuote(
    ticker: string,
    aliceInterval: string,
    nowMs: number = Date.now(),
  ): Promise<TvLiveQuote | null> {
    if (this.stopped) return null
    const timeframe = tvTimeframe(aliceInterval)
    if (!timeframe) return null
    if (!this.connected) {
      // One lazy connect attempt, then wait for the handshake. A failure here is
      // still just a fall-back signal for this tick.
      this.connect()
      const opened = await this.waitForOpen(this.config.subscribeTimeoutMs)
      if (!opened) return null
    }

    const key = cacheKey(ticker, timeframe)
    this.ensureSubscribed(key, ticker, timeframe)

    let cached: CachedTvBar | null = this.cache.get(key) ?? null
    if (!cached) {
      cached = await this.waitForFirstBar(key)
    }
    if (!cached) return null

    const receivedAt = cached.receivedAt
    if (nowMs - receivedAt > this.config.staleMs) return null

    // A closed candle is only reported as `lastClosed` when it is still recent
    // enough to be actionable. An ancient one would let a `candle_close` rule
    // fire on a period the operator has long since moved past.
    const closedBar = this.closedBars.get(key)
    const lastClosed = closedBar && nowMs - closedBar.receivedAt <= this.config.staleMs
      ? {
          timeMs: closedBar.bar.time * 1000,
          open: closedBar.bar.open,
          high: closedBar.bar.high,
          low: closedBar.bar.low,
          close: closedBar.bar.close,
          volume: closedBar.bar.volume,
          receivedAt: closedBar.receivedAt,
        }
      : undefined

    return {
      symbol: cached.bar.symbol,
      timeMs: cached.bar.time * 1000,
      open: cached.bar.open,
      high: cached.bar.high,
      low: cached.bar.low,
      close: cached.bar.close,
      volume: cached.bar.volume,
      receivedAt,
      closed: cached.bar.closed === true,
      ...(lastClosed ? { lastClosed } : {}),
    }
  }

  private ensureSubscribed(key: string, ticker: string, timeframe: string): void {
    if (this.desired.has(key)) return
    this.desired.set(key, { ticker, timeframe })
    this.send({ action: 'subscribe', symbol: ticker, timeframe })
  }

  private waitForFirstBar(key: string): Promise<CachedTvBar | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(key)
        if (list) {
          const next = list.filter((fn) => fn !== onBar)
          if (next.length > 0) this.waiters.set(key, next)
          else this.waiters.delete(key)
        }
        resolve(null)
      }, this.config.subscribeTimeoutMs)
      timer.unref?.()

      const onBar = () => {
        clearTimeout(timer)
        resolve(this.cache.get(key) ?? null)
      }

      const list = this.waiters.get(key)
      if (list) list.push(onBar)
      else this.waiters.set(key, [onBar])
    })
  }

  /** Close the socket and stop reconnecting. Idempotent. */
  close(): void {
    this.stopped = true
    this.connected = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const socket = this.ws
    this.ws = null
    if (socket) {
      try { socket.close() } catch { /* already closed */ }
    }
    for (const list of this.waiters.values()) {
      for (const resolve of list) resolve()
    }
    this.waiters.clear()
    this.flushOpenWaiters(false)
  }
}
