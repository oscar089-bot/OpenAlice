import type { AssetClass } from '../aggregate-search.js'

/**
 * TradingView realtime feed — client-side types.
 *
 * The tv-feed service (`services/tv-feed`) speaks a tiny JSON protocol over
 * WebSocket. This module only models what Alice consumes:
 *
 *   out: { action: 'subscribe' | 'unsubscribe', symbol, timeframe, requestId }
 *   in:  { type: 'bar', bar: TvFeedBar }
 *        { type: 'subscribe' | 'error' | 'info', ... }
 *
 * `symbol` is a TradingView ticker (`BINANCE:BTCUSDT`, `FX:EURUSD`), NOT an
 * Alice barId. See `symbol-map.ts` for the translation.
 */

/** One bar as emitted by the tv-feed service. */
export interface TvFeedBar {
  symbol: string
  timeframe: string
  /** Epoch SECONDS (TradingView convention), not milliseconds. */
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** false/undefined while the candle is still forming. */
  closed?: boolean
}

/** A bar plus the local receive time, so staleness is measured locally. */
export interface CachedTvBar {
  bar: TvFeedBar
  /** Local epoch ms when this bar was received. */
  receivedAt: number
}

/** What the watcher needs: a live, still-forming tail candle. */
export interface TvLiveQuote {
  /** TradingView ticker that produced this quote. */
  symbol: string
  /** Epoch ms of the candle open. */
  timeMs: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** Local epoch ms when received. */
  receivedAt: number
  /** True when the feed reported the candle as final. */
  closed: boolean
  /**
   * The most recent FINAL candle the feed has delivered for this series.
   *
   * Needed because of the service's emit order: on a period rollover it
   * broadcasts the NEW forming candle first and the closed one immediately
   * after. A cache that keeps only "the latest bar" therefore throws the closed
   * candle away, and a `candle_close` rule never sees a confirmed bar. Keeping
   * it separately makes the confirmed candle survive that ordering.
   */
  lastClosed?: {
    /** Epoch ms of the closed candle's open. */
    timeMs: number
    open: number
    high: number
    low: number
    close: number
    volume: number
    /** Local epoch ms when the close was received. */
    receivedAt: number
  }
}

/** Asset classes the live feed is allowed to serve. */
export type TvFeedAssetClass = Extract<AssetClass, 'crypto' | 'currency'>
