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

import type { BarService, OhlcvBar } from '../../domain/market-data/bars/types.js'
import type { AssetClass } from '../../domain/market-data/aggregate-search.js'
import type { Logger } from '../logger.js'

import type {
  WatchAssetClass,
  WatchCandle,
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

export interface WatchSnapshotProviderDeps {
  barService: BarService
  logger: Logger
  now?: () => number
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
  return async (spec) => {
    const nowMs = now()
    try {
      const result = await deps.barService.getBars(
        { symbol: spec.pair, assetClass: toBarAssetClass(spec.assetClass) },
        { interval: spec.timeframe, count: BAR_COUNT },
      )
      const bars = result.bars
      if (bars.length === 0) {
        deps.logger.warn('watch.snapshot_empty', { pair: spec.pair, interval: spec.timeframe })
        return null
      }
      const candles = toWatchCandles(bars, spec.timeframe, nowMs)
      // Live price = the most recent bar's close. Intraday sources refresh the
      // forming bar, so this tracks the market between candle closes.
      const last = candles[candles.length - 1]
      return {
        pair: spec.pair,
        assetClass: spec.assetClass,
        price: last.close,
        timestamp: new Date(nowMs).toISOString(),
        timeframe: spec.timeframe,
        candles,
      }
    } catch (err) {
      deps.logger.warn('watch.snapshot_failed', {
        pair: spec.pair,
        interval: spec.timeframe,
        err: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }
}
