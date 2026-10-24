/**
 * Market snapshot provider — adapts the federated bar layer into watcher terms.
 *
 * The watcher evaluator knows nothing about Alice's market-data stack; it takes
 * a plain `WatchSnapshot`. This module is the only place that bridges the two,
 * so a future provider change never reaches the evaluator.
 *
 * One provider call = one `getBars` request. The loop de-duplicates by pair, so
 * five watchers on the same instrument cost one request.
 */

import { formatBarId, parseBarId } from '../../domain/market-data/bars/types.js'
import type { BarService, OhlcvBar } from '../../domain/market-data/bars/types.js'
import type { AssetClass } from '../../domain/market-data/aggregate-search.js'
import { toTvTicker } from '../../domain/market-data/tv-feed/index.js'
import type { Logger } from '../logger.js'

import type {
  WatchAssetClass,
  WatchCandle,
  WatchPriceSource,
  WatchSnapshot,
  WatchSpec,
} from './types.js'

/** Intervals the federated bar layer can actually serve. Kept in lockstep with
 *  `BAR_INTERVALS` in `bars/bar-service.ts`; a timeframe outside this set would
 *  validate but then fail at fetch time, so the schema rejects it up front. */
export const SUPPORTED_BAR_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const

export function isSupportedBarInterval(value: string): boolean {
  return (SUPPORTED_BAR_INTERVALS as readonly string[]).includes(value)
}

/** Watcher asset classes are a superset of the market-data ones. `forex` is the
 *  product name for what the bar layer calls `currency`; `index` is served by
 *  the equity client, which owns index history. */
export function toBarAssetClass(assetClass: WatchAssetClass): AssetClass {
  switch (assetClass) {
    case 'forex': return 'currency'
    case 'index': return 'equity'
    case 'equity': return 'equity'
    case 'commodity': return 'commodity'
    case 'crypto': return 'crypto'
  }
}

/** How many bars to request. Enough for a `candle_close` rule to see the last
 *  confirmed candle plus its predecessor, without over-fetching history. */
const BAR_COUNT = 5

/**
 * Parse a bar timestamp into epoch ms.
 *
 * `bars/bar-service.ts` renders daily/weekly bars as `YYYY-MM-DD` and intraday
 * bars as an ISO instant. A bare date is read as UTC midnight, which is the
 * same convention the bar layer uses for daily buckets.
 */
export function parseBarTime(date: string): number | null {
  if (!date) return null
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : date
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

function timeframeMs(timeframe: string): number {
  const match = timeframe.trim().toLowerCase().match(/^(\d+)([mhdw])$/)
  if (!match) return 0
  const n = Number.parseInt(match[1], 10)
  if (!Number.isFinite(n) || n <= 0) return 0
  switch (match[2]) {
    case 'm': return n * 60_000
    case 'h': return n * 3_600_000
    case 'd': return n * 86_400_000
    case 'w': return n * 7 * 86_400_000
    default: return 0
  }
}

/**
 * Convert bars into watcher candles, marking the still-forming tail unconfirmed.
 *
 * Confirmation matters: a `candle_close` rule must never fire on a candle that
 * can still change. A bar is confirmed once `open + interval <= now`.
 */
export function toWatchCandles(
  bars: OhlcvBar[],
  timeframe: string,
  nowMs: number,
): WatchCandle[] {
  const span = timeframeMs(timeframe)
  return bars.map((bar) => {
    const openedAt = parseBarTime(bar.date)
    const confirmed = span > 0 && openedAt !== null ? openedAt + span <= nowMs : false
    return {
      timestamp: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      timeframe,
      confirmed,
    }
  })
}

/**
 * Crypto watchers default to the keyless OKX exchange feed.
 *
 * Both yfinance and OKX are live for crypto intraday, so this is not a latency
 * choice. It is a namespace + venue choice: OKX speaks exchange-native pairs
 * (`SOL-USDT`) with real exchange volume and matches the venue a crypto trader
 * actually executes on, whereas yfinance uses Yahoo tickers (`SOL-USD`) whose
 * symbol space and spot-volume semantics differ. It also mirrors Vibe-Trading,
 * whose watcher routes crypto to `OKXMarketDataProvider` and only forex to
 * yfinance.
 */
const PREFERRED_CRYPTO_VENDOR = 'okx'

/**
 * Normalize an authored crypto symbol to OKX's `BASE-QUOTE` native form.
 *
 * The model may write a bare base asset (`SOL`), an exchange-style pair
 * (`SOLUSDT`), a slash pair (`SOL/USDT`), or a Yahoo ticker (`SOL-USD`). OKX
 * spot is USDT-quoted by default, so a trailing `USD` is widened to `USDT` —
 * `SOL-USD` is not an OKX spot instrument, `SOL-USDT` is.
 */
export function normalizeCryptoNative(symbol: string): string {
  const raw = symbol.trim().toUpperCase().replace(/[/_\s]/g, '-')
  if (!raw) return raw
  // Derivative / dated symbols carry a `:` settlement segment
  // (`ETH/USDT:USDT`, `BTC/USD:USD-310613`). They are already venue-native and
  // belong to a different instrument class; never rewrite them.
  if (raw.includes(':')) return raw
  // An already-hyphenated pair: widen a Yahoo-style `-USD` to the tradable
  // `-USDT`, since `SOL-USD` is not an OKX spot instrument but `SOL-USDT` is.
  if (raw.includes('-')) return raw.endsWith('-USD') ? `${raw.slice(0, -3)}USDT` : raw
  for (const quote of ['USDT', 'USDC', 'BTC', 'ETH', 'USD']) {
    if (raw.endsWith(quote) && raw.length > quote.length) {
      const base = raw.slice(0, -quote.length)
      return `${base}-${quote === 'USD' ? 'USDT' : quote}`
    }
  }
  // A bare base asset (SOL) → the exchange's default USDT pair.
  return `${raw}-USDT`
}

/**
 * Normalize an authored crypto symbol to Yahoo Finance's spot ticker form.
 *
 * Yahoo quotes crypto as `BASE-USD` (`SOL-USD`), a DIFFERENT namespace from
 * OKX's `BASE-USDT`: `SOL-USD` is a valid Yahoo ticker and an invalid OKX spot
 * instrument. A watcher explicitly pinned to yfinance must normalize here
 * rather than through {@link normalizeCryptoNative}, which deliberately widens
 * `USD` to `USDT` for the exchange feed.
 *
 * Accepts the same authored spellings (`SOL`, `SOLUSD`, `SOL/USDT`, `SOL-USD`)
 * and lands them all on `SOL-USD`. A non-dollar quote is preserved because
 * Yahoo lists those pairs too (`BTC-USDC`).
 */
export function normalizeCryptoYahoo(symbol: string): string {
  const raw = symbol.trim().toUpperCase().replace(/[/_\s]/g, '-')
  if (!raw) return raw
  // Derivative / dated symbols are venue-specific and never Yahoo spot tickers.
  if (raw.includes(':')) return raw
  // `USDT` is the exchange spelling of the same dollar peg Yahoo calls `USD`.
  if (raw.endsWith('-USDT')) return `${raw.slice(0, -5)}-USD`
  if (raw.includes('-')) return raw
  for (const quote of ['USDT', 'USDC', 'BTC', 'ETH', 'USD']) {
    if (raw.endsWith(quote) && raw.length > quote.length) {
      const base = raw.slice(0, -quote.length)
      return `${base}-${quote === 'USDT' ? 'USD' : quote}`
    }
  }
  return `${raw}-USD`
}

/** Verdict from {@link validateWatchPair}: either clean, or one actionable message. */
export type WatchPairVerdict = { ok: true } | { ok: false; error: string }

/**
 * Authoring guard for `watch.pair` — STRICT where {@link resolveWatchRef} is
 * tolerant.
 *
 * `resolveWatchRef` silently repairs normalizable input so a hand-edited or
 * legacy Issue still prices. This guard runs at schema time instead, so the
 * model is TOLD what is wrong and what to write, rather than shipping a watcher
 * that quietly fails every poll. It mirrors Vibe-Trading, whose
 * `normalize_forex_pair` raises `ValueError("forex pair must look like EURUSD,
 * EUR/USD, or EURUSD=X")` and whose `watcher_manager` returns bad pairs with a
 * correction instead of accepting them.
 *
 * Only genuinely wrong shapes are rejected. Every form that normalizes cleanly
 * (`SOL`, `SOLUSDT`, `SOL/USDT`, `SOL-USD`) passes, so the guard corrects
 * mistakes without being pedantic.
 */
export function validateWatchPair(pair: string, assetClass: WatchAssetClass): WatchPairVerdict {
  const raw = pair.trim()
  if (!raw) return { ok: false, error: 'pair is required' }
  const parsed = parseBarId(raw)

  if (assetClass === 'crypto') {
    // Both venues are priceable for crypto, so every authored form is valid:
    //   `SOL`          → the exchange-native default (OKX)
    //   `SOL-USDT`     → exchange-native, routed to OKX
    //   `yfinance|SOL-USD` → Yahoo spot, normalized to Yahoo's namespace
    //   `bybit-main|…` → an explicit broker venue, honored verbatim
    // This branch used to REJECT `yfinance|…` because the resolver silently
    // retargeted it to OKX, so the author's intent was discarded. The resolver
    // now honors an explicit venue, which makes the form honest — and a guard
    // that rejects a working spelling is worse than no guard.
    return { ok: true }
  }

  if (assetClass === 'forex') {
    if (parsed) {
      return {
        ok: false,
        error:
          `pair "${raw}" is a barId, but forex watchers use a bare yfinance spot pair. ` +
          `Write "EURUSD", "EUR/USD", or "EURUSD=X" instead of "${raw}".`,
      }
    }
    const upper = raw.toUpperCase()
    const letters = upper.replace(/[^A-Z]/g, '')
    if (!upper.endsWith('=X') && letters.length !== 6) {
      return {
        ok: false,
        error:
          `pair "${raw}" is not a currency pair. Forex watchers must look like ` +
          `"EURUSD", "EUR/USD", or "EURUSD=X".`,
      }
    }
    return { ok: true }
  }

  // equity / commodity / index legitimately address a bare symbol or a source
  // barId (e.g. "eastmoney|1.600519"); the bar layer validates their shape.
  return { ok: true }
}

/**
 * Resolve an authored `watch.pair` to a bar-layer reference.
 *
 * `pair` is authored by the model, which often copies a `source|native` barId
 * straight from `market search-bars` instead of a bare symbol. Both forms are
 * accepted:
 *
 *   - `SOL-USDT`            → symbol, routed to the default crypto venue (OKX)
 *   - `okx|SOL-USDT`        → explicit source, honored as written
 *   - `yfinance|SOL-USD`    → explicit source, honored on Yahoo's namespace
 *   - `yfinance|SOLUSD`     → same, normalized to `SOL-USD`
 *
 * An explicit venue WINS for crypto. The earlier behaviour rewrote every
 * non-broker source to OKX, which made it impossible to price a crypto watcher
 * from yfinance even when the author asked for it by name. A bare symbol (no
 * `|`) still defaults to the exchange feed, because that is the venue a crypto
 * trader executes on and the one with real exchange volume.
 */
export type WatchBarRef =
  | { barId: string; assetClass: AssetClass }
  | { symbol: string; assetClass: AssetClass }

export function resolveWatchRef(spec: WatchSpec): WatchBarRef {
  const assetClass = toBarAssetClass(spec.assetClass)
  const parsed = parseBarId(spec.pair.trim())
  const native = parsed ? parsed.nativeSymbol : spec.pair.trim()

  if (assetClass === 'crypto') {
    // Explicit venue: honor it, normalizing into THAT venue's symbol
    // namespace. yfinance quotes `BASE-USD`; the exchange feed quotes
    // `BASE-USDT`, so the two cannot share one normalizer.
    if (parsed?.sourceId === 'yfinance') {
      return { barId: formatBarId('yfinance', normalizeCryptoYahoo(native)), assetClass }
    }
    // Any other explicit venue (okx, a broker/UTA id) already speaks its own
    // symbol namespace — honor it verbatim.
    if (parsed) {
      return { barId: spec.pair.trim(), assetClass }
    }
    // Bare symbol ⇒ the exchange-native default.
    return { barId: formatBarId(PREFERRED_CRYPTO_VENDOR, normalizeCryptoNative(native)), assetClass }
  }
  if (parsed) return { barId: formatBarId(parsed.sourceId, native), assetClass }
  return { symbol: native, assetClass }
}

export interface WatchSnapshotProviderDeps {
  barService: BarService
  logger: Logger
  now?: () => number
  /**
   * Optional live TradingView quote source.
   *
   * When present AND the watcher's asset class is enabled in `tv-feed.json`,
   * the pair's PRICE comes from the live push feed instead of the delayed
   * federated bar layer. History still comes from `barService`, because the
   * live feed only ever sends the still-forming candle — `candle_close` rules
   * need the confirmed candles behind it.
   *
   * Absent, disabled, disconnected, stale, or unsupported ⇒ the provider
   * behaves exactly as before. This is the whole safety story: the live feed
   * can only ever make a snapshot fresher, never make one disappear.
   */
  tvFeed?: import('../../domain/market-data/tv-feed/index.js').TvFeedClient
  /** Asset classes allowed to use the live feed (from `tv-feed.json`). */
  tvFeedAssetClasses?: readonly WatchAssetClass[]
}

/**
 * Convert a live forming candle into watcher terms.
 *
 * The feed's `closed` flag is authoritative for *whether the service considers
 * the candle final*, but it is NOT trusted on its own: a re-subscribe can replay
 * a just-closed period, and a clock skew can deliver `closed` before the period
 * has actually elapsed locally. `candle_close` rules must never fire on a candle
 * that could still change, so confirmation additionally requires the period to
 * have ended by OUR clock.
 *
 * The guard is one-directional: it can only downgrade a suspicious `closed` to
 * `confirmed: false`, never upgrade a forming candle. So it cannot make a
 * watcher fire more eagerly than the local time allows.
 */
function liveToWatchCandle(
  quote: import('../../domain/market-data/tv-feed/index.js').TvLiveQuote,
  timeframe: string,
  nowMs: number,
): WatchCandle {
  const span = timeframeMs(timeframe)
  const periodEnded = span > 0 && quote.timeMs + span <= nowMs
  return {
    timestamp: new Date(quote.timeMs).toISOString(),
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.close,
    volume: quote.volume,
    timeframe,
    confirmed: quote.closed && periodEnded,
  }
}

/**
 * Merge the live forming candle onto history.
 *
 * History is authoritative for anything older than the live candle. When the
 * live candle is newer than the last history bar it is appended; when it is the
 * same period it REPLACES the history bar (whose close is a delayed snapshot of
 * the same candle). A live candle OLDER than history is ignored — history wins.
 */
function mergeLiveCandle(
  history: WatchCandle[],
  live: WatchCandle,
): WatchCandle[] {
  const liveMs = parseBarTime(live.timestamp)
  if (liveMs === null) return [...history, live]

  const merged: WatchCandle[] = []
  let replaced = false
  for (const candle of history) {
    const candleMs = parseBarTime(candle.timestamp)
    if (candleMs === null || candleMs < liveMs) {
      merged.push(candle)
    } else if (candleMs === liveMs) {
      merged.push(live)
      replaced = true
    }
    // candleMs > liveMs: the live candle is behind history — drop it.
  }
  if (!replaced && merged.length === history.length) {
    merged.push(live)
  }
  return merged
}

/**
 * Every distinct candle interval this snapshot must carry.
 *
 * A `candle_close` rule may name its OWN `timeframe`, independent of
 * `watch.timeframe`. The evaluator filters candles strictly by the RULE's
 * timeframe (`matchingCandles`), so serving only `spec.timeframe` silently
 * starves such a rule: it sees zero candles and can never fire.
 *
 * Fetching the union makes "a 15m close inside a 1h watcher" work, which is the
 * whole point of a per-rule timeframe.
 */
export function requiredSnapshotIntervals(spec: WatchSpec): string[] {
  const intervals = new Set<string>()
  const primary = (spec.timeframe ?? '').trim()
  if (primary) intervals.add(primary)
  for (const rule of [...spec.rules, ...spec.invalidationRules]) {
    if (rule.type !== 'candle_close') continue
    const timeframe = (rule.timeframe ?? '').trim()
    if (timeframe) intervals.add(timeframe)
  }
  return [...intervals]
}

/**
 * Build the loop's market access.
 *
 * Returns null (never throws) when a pair cannot be priced, so the loop records
 * a data error and moves on instead of turning an outage into a fire.
 */
export function createWatchSnapshotProvider(
  deps: WatchSnapshotProviderDeps,
): (spec: WatchSpec) => Promise<WatchSnapshot | null> {
  const now = deps.now ?? Date.now

  /** Live quote for one interval, or null when the feed cannot serve it. */
  const tryLiveQuote = async (
    spec: WatchSpec,
    interval: string,
  ): Promise<import('../../domain/market-data/tv-feed/index.js').TvLiveQuote | null> => {
    const feed = deps.tvFeed
    if (!feed) return null
    const allowed = deps.tvFeedAssetClasses ?? ['crypto', 'forex']
    if (!allowed.includes(spec.assetClass)) return null
    const assetClass = toBarAssetClass(spec.assetClass)
    const ticker = toTvTicker(spec.pair, assetClass)
    if (!ticker) return null
    try {
      return await feed.getQuote(ticker, interval, now())
    } catch {
      return null
    }
  }

  /**
   * History + live tail for ONE interval.
   *
   * Every candle it returns is labelled with this interval, which is what lets
   * the evaluator's per-rule timeframe filter select it.
   */
  const candlesForInterval = async (
    spec: WatchSpec,
    ref: WatchBarRef,
    interval: string,
    nowMs: number,
  ): Promise<{ candles: WatchCandle[]; live: import('../../domain/market-data/tv-feed/index.js').TvLiveQuote | null }> => {
    const live = await tryLiveQuote(spec, interval)

    let history: WatchCandle[] = []
    try {
      const result = await deps.barService.getBars(
        ref,
        { interval, count: BAR_COUNT },
      )
      history = toWatchCandles(result.bars, interval, nowMs)
    } catch (err) {
      // History is a nice-to-have on the live path: a level rule can be
      // evaluated from the live candle alone. Never let it veto the quote.
      deps.logger.warn('watch.snapshot_history_failed', {
        pair: spec.pair,
        interval,
        err: err instanceof Error ? err.message : String(err),
      })
    }

    if (!live) return { candles: history, live: null }

    // Order matters: fold the CLOSED candle into history first, then the
    // forming tail. Doing it the other way round would drop the older close,
    // because `mergeLiveCandle` discards anything behind its live candle.
    let candles = history
    if (live.lastClosed) {
      const closedSpan = timeframeMs(interval)
      const closedEnded = closedSpan > 0 && live.lastClosed.timeMs + closedSpan <= nowMs
      candles = mergeLiveCandle(candles, {
        timestamp: new Date(live.lastClosed.timeMs).toISOString(),
        open: live.lastClosed.open,
        high: live.lastClosed.high,
        low: live.lastClosed.low,
        close: live.lastClosed.close,
        volume: live.lastClosed.volume,
        timeframe: interval,
        // The feed said final; still require the period to have elapsed locally
        // so a replayed close cannot fire a rule early.
        confirmed: closedEnded,
      })
    }
    candles = mergeLiveCandle(candles, liveToWatchCandle(live, interval, nowMs))

    return { candles, live }
  }

  return async (spec) => {
    const nowMs = now()
    const ref = resolveWatchRef(spec)
    const intervals = requiredSnapshotIntervals(spec)

    const results = await Promise.all(
      intervals.map((interval) => candlesForInterval(spec, ref, interval, nowMs)),
    )

    // `price` drives every level/zone rule, so it must come from the watcher's
    // OWN timeframe. A live quote on a secondary interval is only a fallback.
    const primaryIndex = intervals.indexOf((spec.timeframe ?? '').trim())
    const primary = primaryIndex >= 0 ? results[primaryIndex] : results[0]
    const liveForPrice = primary?.live
      ?? results.find((r) => r.live)?.live
      ?? null

    const candles: WatchCandle[] = []
    let lastHistoryClose: number | null = null
    for (const result of results) {
      candles.push(...result.candles)
      const last = result.candles[result.candles.length - 1]
      if (last && typeof last.close === 'number') lastHistoryClose = last.close
    }

    const price = liveForPrice?.close ?? lastHistoryClose
    if (price === null || !Number.isFinite(price)) {
      deps.logger.warn('watch.snapshot_empty', {
        pair: spec.pair,
        barId: 'barId' in ref ? ref.barId : ref.symbol,
        interval: spec.timeframe,
      })
      return null
    }

    // Record WHICH path served this price. `tryLiveQuote` returns null for every
    // abnormal case (feed off, class not allowed, unmapped symbol, stale, or
    // simply no bar yet), so a null here means "vendor" — and when the feed WAS
    // eligible, that is a fallback worth reporting rather than hiding.
    const feedEligible = Boolean(deps.tvFeed)
      && (deps.tvFeedAssetClasses ?? ['crypto', 'forex']).includes(spec.assetClass)
    const priceSource: WatchPriceSource = liveForPrice
      ? { kind: 'tv-feed', ref: liveForPrice.symbol }
      : {
          kind: 'vendor',
          ref: 'barId' in ref ? ref.barId : ref.symbol,
          ...(feedEligible ? { fellBack: true } : {}),
        }

    return {
      pair: spec.pair,
      assetClass: spec.assetClass,
      price,
      timestamp: new Date(nowMs).toISOString(),
      timeframe: spec.timeframe,
      candles,
      priceSource,
    }
  }
}
