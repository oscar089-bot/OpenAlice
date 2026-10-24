/**
 * Watcher core types — the deterministic market-condition layer.
 *
 * A watcher is authored as a `watch:` block on an Issue. It carries one or more
 * deterministic rules plus the plan the woken Session should receive. Nothing
 * here calls an LLM or performs I/O; the evaluator is pure so the hot poll
 * loop stays cheap and testable.
 *
 * Ported from the Vibe-Trading watcher subsystem (`agent/src/watcher/models.py`
 * and `evaluator.py`). See [[docs/workspace-issues-and-scheduling.md]].
 */

/** Live market facts for one evaluation pass. */
export interface WatchCandle {
  /** Candle open time, ISO string. */
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume?: number | null
  /** Candle interval, e.g. `1m`, `5m`, `15m`, `1h`, `4h`, `1d`. */
  timeframe?: string
  /** A candle still forming must set `false`; only confirmed candles are
   *  eligible for `candle_close` rules. Omitted is treated as confirmed. */
  confirmed?: boolean
}

export interface WatchSnapshot {
  pair: string
  assetClass: WatchAssetClass
  price: number
  /** Observation time, ISO string. */
  timestamp: string
  timeframe?: string
  candles?: WatchCandle[]
  /**
   * WHERE this price came from.
   *
   * Recorded because a price alone cannot tell an operator (or the model) which
   * path served it: a live push quote and a delayed vendor bar are both just a
   * number. Without this, an agent inspecting a watcher has to guess, and will
   * reasonably conclude "delayed" whenever it cannot find a process to point
   * at.
   */
  priceSource?: WatchPriceSource
}

/** Provenance for one snapshot's price. */
export interface WatchPriceSource {
  /** `tv-feed` = real-time TradingView push; `vendor` = federated bar layer. */
  kind: 'tv-feed' | 'vendor'
  /** The exact ticker/barId that produced the price, for verification. */
  ref: string
  /** True when the live feed was tried but did not supply a usable quote. */
  fellBack?: boolean
}

export type WatchAssetClass = 'crypto' | 'forex' | 'equity' | 'commodity' | 'index'

/** Direction of the setup a watcher belongs to. */
export type WatchDirection = 'LONG' | 'SHORT' | ''

/** Which side of a level a rule acts on. */
export type WatchSide = 'above' | 'below'

/** Deterministic rule kinds.
 *
 * Level rules use `side` + `level`. Zone rules use `low` + `high`. The candle
 * rule additionally uses `timeframe`. `condition` is deliberately NOT a field —
 * the evaluator reads `side`. */
export type WatchRuleType =
  | 'price_breaks_level'
  | 'price_crosses_level'
  | 'candle_close'
  | 'level_reclaim'
  | 'level_breakdown'
  | 'liquidity_sweep_touched'
  | 'price_enters_zone'
  | 'price_approaches_zone'

/** Trade-management rules read the stored `position` block instead of a level. */
export type WatchManagementRuleType =
  | 'r_multiple_reached'
  | 'unrealized_pnl_pct'

export interface WatchRule {
  type: WatchRuleType
  /** Stable author-supplied id; falls back to a derived condition key. */
  id?: string
  side?: WatchSide
  level?: number
  low?: number
  high?: number
  timeframe?: string
  /** Absolute distance for `price_approaches_zone`. */
  threshold?: number
  /** Fractional distance for `price_approaches_zone`, e.g. `0.002` = 0.2%. */
  thresholdPct?: number
}

export interface WatchManagementRule {
  type: WatchManagementRuleType
  id?: string
  /** R multiple for `r_multiple_reached`, e.g. `2` = 2R in favour. */
  multiple?: number
  /** Percent for `unrealized_pnl_pct`. Positive means profit. */
  pct?: number
  op?: WatchSide
}

/** Stored position context so management rules never query another process.
 *
 * Entry, stop, and direction are written when the watcher is created; rules
 * compare that frozen context against live price. This is what lets management
 * watchers work while UTA is offline. */
export interface WatchPosition {
  side: 'LONG' | 'SHORT'
  entry: number
  stop?: number
  /** Take-profit levels, in the order the author cares about them. */
  targets?: number[]
  size?: number
}

/** A watch is terminal once it fires a one-shot or its invalidation/expiry hits.
 *  Repeating watchers stay `armed` so the model can re-arm per phase. */
export type WatchStatus =
  | 'armed'
  | 'triggered'
  | 'invalidated'
  | 'expired'
  | 'cancelled'

/** Event kinds emitted by one evaluation pass. */
export type WatchEventType =
  | 'TRIGGER_HIT'
  | 'TRIGGER_CLOSE'
  | 'MANAGEMENT_ALERT'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'ERROR'

/** Persisted watcher runtime state. Survives restart so a fired rule does not
 *  re-fire and a closed candle is not re-evaluated. */
export interface WatchState {
  /** When the current rule set was armed. Candle closes at or before this are
   *  ignored, so re-arming does not replay history. */
  armedAt: string | null
  /** Fingerprint of the authored spec this state belongs to. When the model
   *  rewrites its Issue to re-arm, the fingerprint changes and the loop resets
   *  to a fresh state so the previous phase's firing history cannot suppress
   *  the new phase's rules. */
  specFingerprint: string | null
  lastChecked: string | null
  lastPrice: number | null
  lastMarketTimestamp: string | null
  /** Which source produced `lastPrice`. Persisted so a restart does not lose
   *  the answer to "is this watcher on live data?". Optional because records
   *  written before this field existed are still valid. */
  lastPriceSource?: WatchPriceSource | null
  lastConfirmedCandle: WatchCandle | null
  previousConfirmedCandle: WatchCandle | null
  lastEvent: string | null
  /** Set once the watcher reached a terminal state (invalidation or expiry).
   *  The loop stops collecting terminal watchers, so a dead condition costs no
   *  fetches. Rewriting the Issue's `watch:` block changes the spec fingerprint
   *  and re-arms with a fresh state, clearing this. */
  terminal: boolean
  /** conditionKey -> ISO time it last alerted. */
  alertedConditions: Record<string, string>
  /** conditionKey -> ISO time it fired. */
  firedConditions: Record<string, string>
  cooldownUntil: string | null
  /** When the market fetch is failing, the time before which no further fetch
   *  is attempted. Persisted so a restart cannot reset the backoff and hammer a
   *  dead provider. Cleared on the first successful fetch. */
  backoffUntil: string | null
  pollCount: number
  errorCount: number
  lastError: string | null
}

/** One emitted watcher event, appended to the watcher's event log. */
export interface WatchEvent {
  watcherId: string
  eventType: WatchEventType
  conditionKey: string
  message: string
  price: number | null
  at: string
  data?: Record<string, unknown>
}

/** The full watch spec as authored on an Issue. */
export interface WatchSpec {
  pair: string
  assetClass: WatchAssetClass
  direction: WatchDirection
  timeframe: string
  rules: WatchRule[]
  invalidationRules: WatchRule[]
  managementRules: WatchManagementRule[]
  position?: WatchPosition
  /** ISO timestamp after which the watcher expires. */
  expiry?: string
  /** Presentation context for the board card. Never read by the evaluator. */
  meta?: WatchMeta
}

/** Plan context the model authors alongside the rules, shown on the board. */
export interface WatchMeta {
  grade?: string
  rating?: string | number
  phase?: string
  nextStep?: string
  waitingTrigger?: string
  invalidationConditions?: string[]
}

export function emptyWatchState(now: string): WatchState {
  return {
    armedAt: now,
    specFingerprint: null,
    lastChecked: null,
    lastPrice: null,
    lastMarketTimestamp: null,
    lastPriceSource: null,
    lastConfirmedCandle: null,
    previousConfirmedCandle: null,
    lastEvent: null,
    terminal: false,
    alertedConditions: {},
    firedConditions: {},
    cooldownUntil: null,
    backoffUntil: null,
    pollCount: 0,
    errorCount: 0,
    lastError: null,
  }
}

/** Default anti-spam cooldown, matching Vibe-Trading. */
export const DEFAULT_COOLDOWN_SECONDS = 900

/** Only these candle intervals may be requested; 30s candles are unreliable. */
export const MIN_CANDLE_TIMEFRAME_SECONDS = 60
