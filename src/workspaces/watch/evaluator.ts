/**
 * Deterministic watcher rule evaluation.
 *
 * Pure: no I/O, no clock of its own (every entry point takes an explicit `now`),
 * no LLM. The watch loop calls {@link evaluateWatch} with a market snapshot
 * and persists whatever it returns.
 *
 * Ported from the Vibe-Trading watcher subsystem
 * (`agent/src/watcher/evaluator.py`). The rules, anti-spam bookkeeping, and
 * candle-close arming semantics are deliberately identical so operators get the
 * behavior they already trust.
 */

import {
  DEFAULT_COOLDOWN_SECONDS,
  emptyWatchState,
  type WatchCandle,
  type WatchEvent,
  type WatchEventType,
  type WatchManagementRule,
  type WatchRule,
  type WatchSnapshot,
  type WatchSpec,
  type WatchState,
} from './types.js'

/** Caller-tunable anti-spam knobs. */
export interface EvaluatorConfig {
  cooldownSeconds: number
  approachThresholdPct: number
}

export const DEFAULT_EVALUATOR_CONFIG: EvaluatorConfig = {
  cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
  approachThresholdPct: 0.002,
}

export interface EvaluationResult {
  /** State to persist. Always returned, even when no event fired. */
  state: WatchState
  /** Events to deliver, in evaluation order. Empty means nothing fired. */
  events: WatchEvent[]
  /** True once the watcher reached a terminal status this pass. */
  terminal: boolean
}

// ==================== time helpers ====================

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const raw = value.trim().replace(/Z$/, '+00:00')
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}

/** Parse a timeframe label (`1m`, `15m`, `4h`, `1d`) into seconds. */
export function timeframeSeconds(value: string | undefined): number {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!raw) return 0
  const aliases: Record<string, string> = {
    '1min': '1m', '1minute': '1m',
    '5min': '5m', '5minute': '5m',
    '15min': '15m', '15minute': '15m',
    '30min': '30m', '30minute': '30m',
    '1hr': '1h', '1hour': '1h',
    '4hr': '4h', '4hour': '4h',
    '1day': '1d', 'daily': '1d',
  }
  const normalized = aliases[raw] ?? raw
  const match = normalized.match(/^(\d+)([mhdw])$/)
  if (!match) return 0
  const n = Number.parseInt(match[1], 10)
  if (!Number.isFinite(n) || n <= 0) return 0
  switch (match[2]) {
    case 'm': return n * 60
    case 'h': return n * 3600
    case 'd': return n * 86400
    case 'w': return n * 7 * 86400
    default: return 0
  }
}

/** Close time of a candle = open time + its interval. */
function candleCloseTime(candle: WatchCandle, fallbackTimeframe: string): number | null {
  const open = parseTime(candle.timestamp)
  if (open === null) return null
  const seconds = timeframeSeconds(candle.timeframe ?? fallbackTimeframe)
  return seconds > 0 ? open + seconds * 1000 : open
}

// ==================== condition keys ====================

/** Stable key so one rule cannot fire twice. Mirrors Vibe-Trading's
 *  `_rule_key`: an explicit `id` wins, otherwise a deterministic derivation
 *  from the rule's meaningful fields. */
export function ruleConditionKey(eventType: WatchEventType, rule: WatchRule, index: number): string {
  const type = rule.type || 'rule'
  if (rule.id) return `${eventType}:${rule.id}`
  if (type === 'price_enters_zone' || type === 'price_approaches_zone') {
    return `${eventType}:${type}:${rule.low}:${rule.high}`
  }
  if (type === 'candle_close') {
    return `${eventType}:${type}:${rule.timeframe ?? ''}:${rule.side ?? ''}:${rule.level}`
  }
  if (rule.level !== undefined) {
    return `${eventType}:${type}:${rule.side ?? ''}:${rule.level}`
  }
  return `${eventType}:${type}:${index}`
}

export function managementConditionKey(rule: WatchManagementRule, index: number): string {
  if (rule.id) return `MANAGEMENT_ALERT:${rule.id}`
  if (rule.type === 'r_multiple_reached') return `MANAGEMENT_ALERT:r:${rule.multiple}`
  return `MANAGEMENT_ALERT:pnl:${rule.op ?? ''}:${rule.pct}`
}

// ==================== level helpers ====================

function breached(current: number, level: number, side: 'above' | 'below'): boolean {
  return side === 'above' ? current >= level : current <= level
}

function crossed(previous: number | null, current: number, level: number, side: 'above' | 'below'): boolean {
  if (previous === null) return false
  return side === 'above'
    ? current >= level && previous < level
    : current <= level && previous > level
}

function zoneBounds(rule: WatchRule): { low: number; high: number } | null {
  const { low, high } = rule
  if (typeof low !== 'number' || typeof high !== 'number') return null
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  return low <= high ? { low, high } : { low: high, high: low }
}

function distanceToZone(price: number, low: number, high: number): number {
  if (price >= low && price <= high) return 0
  return price < low ? low - price : price - high
}

function approachThreshold(rule: WatchRule, price: number, config: EvaluatorConfig): number {
  if (typeof rule.threshold === 'number' && Number.isFinite(rule.threshold)) {
    return Math.abs(rule.threshold)
  }
  const pct = typeof rule.thresholdPct === 'number' && Number.isFinite(rule.thresholdPct)
    ? Math.abs(rule.thresholdPct)
    : config.approachThresholdPct
  return Math.abs(price) * pct
}

/** Resolve the effective side, defaulting from the setup direction. */
function effectiveSide(rule: WatchRule, direction: string): 'above' | 'below' | null {
  if (rule.side === 'above' || rule.side === 'below') return rule.side
  if (rule.type === 'level_reclaim') return 'above'
  if (rule.type === 'level_breakdown') return 'below'
  if (direction === 'SHORT') return 'below'
  if (direction === 'LONG') return 'above'
  return null
}

// ==================== candle selection ====================

function matchingCandles(snapshot: WatchSnapshot, timeframe: string): WatchCandle[] {
  const expected = timeframe.trim().toLowerCase()
  const out: WatchCandle[] = []
  for (const candle of snapshot.candles ?? []) {
    if (!candle || typeof candle.close !== 'number') continue
    const candleTf = String(candle.timeframe ?? '').trim().toLowerCase()
    if (expected && candleTf && candleTf !== expected) continue
    out.push(candle)
  }
  return out
}

/** Candle timeframe the primary rules care about (first candle_close rule). */
export function primaryCandleTimeframe(spec: WatchSpec, snapshot: WatchSnapshot): string {
  for (const rule of [...spec.rules, ...spec.invalidationRules]) {
    if (rule.type !== 'candle_close') continue
    if (rule.timeframe) return rule.timeframe
  }
  return spec.timeframe || snapshot.timeframe || ''
}

/** Evaluate a `candle_close` rule.
 *
 * Only CONFIRMED candles count. A candle whose close time is at or before the
 * arming time is ignored, so re-arming a watcher never replays history. */
function candleCloseHit(
  snapshot: WatchSnapshot,
  rule: WatchRule,
  spec: WatchSpec,
  armedAtMs: number | null,
): { hit: boolean; candle?: WatchCandle; close?: number; previousClose?: number | null } {
  if (typeof rule.level !== 'number' || !Number.isFinite(rule.level)) return { hit: false }
  const side = effectiveSide(rule, spec.direction)
  if (!side) return { hit: false }

  const timeframe = (rule.timeframe ?? spec.timeframe ?? snapshot.timeframe ?? '').trim().toLowerCase()
  const confirmed = matchingCandles(snapshot, timeframe).filter((c) => c.confirmed !== false)
  if (confirmed.length === 0) return { hit: false }

  for (let i = 0; i < confirmed.length; i++) {
    const candle = confirmed[i]
    const closeAt = candleCloseTime(candle, timeframe)
    if (armedAtMs !== null && closeAt !== null && closeAt <= armedAtMs) continue
    if (!breached(candle.close, rule.level, side)) continue
    const previous = i > 0 ? confirmed[i - 1] : undefined
    return {
      hit: true,
      candle,
      close: candle.close,
      previousClose: previous ? previous.close : null,
    }
  }
  return { hit: false }
}

// ==================== rule evaluation ====================

interface RuleHit {
  eventType: WatchEventType
  rule: WatchRule
  conditionKey: string
  message: string
  data: Record<string, unknown>
}

function evaluateRule(
  rule: WatchRule,
  index: number,
  spec: WatchSpec,
  snapshot: WatchSnapshot,
  previousPrice: number | null,
  state: WatchState,
  config: EvaluatorConfig,
  eventType: WatchEventType,
): RuleHit | null {
  const price = snapshot.price
  const direction = spec.direction
  const armedAtMs = parseTime(state.armedAt)

  switch (rule.type) {
    case 'candle_close': {
      const result = candleCloseHit(snapshot, rule, spec, armedAtMs)
      if (!result.hit) return null
      const side = effectiveSide(rule, direction) ?? 'above'
      return {
        eventType,
        rule,
        conditionKey: ruleConditionKey(eventType, rule, index),
        message: `${spec.pair} ${rule.timeframe ?? spec.timeframe} candle closed ${side} ${rule.level}.`,
        data: {
          rule,
          currentPrice: price,
          timeframe: rule.timeframe ?? spec.timeframe,
          level: rule.level,
          side,
          currentCandle: result.candle,
          currentClose: result.close,
          previousClose: result.previousClose,
        },
      }
    }

    case 'price_breaks_level':
    case 'level_reclaim':
    case 'level_breakdown': {
      if (typeof rule.level !== 'number' || !Number.isFinite(rule.level)) return null
      const side = effectiveSide(rule, direction)
      if (!side) return null
      if (!breached(price, rule.level, side)) return null
      return {
        eventType,
        rule,
        conditionKey: ruleConditionKey(eventType, rule, index),
        message: `${spec.pair} broke ${side} ${rule.level} (now ${price}).`,
        data: { rule, currentPrice: price, level: rule.level, side },
      }
    }

    case 'price_crosses_level': {
      if (typeof rule.level !== 'number' || !Number.isFinite(rule.level)) return null
      const side = effectiveSide(rule, direction)
      if (!side) return null
      if (!crossed(previousPrice, price, rule.level, side)) return null
      return {
        eventType,
        rule,
        conditionKey: ruleConditionKey(eventType, rule, index),
        message: `${spec.pair} crossed ${side} ${rule.level} (${previousPrice} -> ${price}).`,
        data: { rule, currentPrice: price, previousPrice, level: rule.level, side },
      }
    }

    case 'liquidity_sweep_touched': {
      if (typeof rule.level !== 'number' || !Number.isFinite(rule.level)) return null
      const side = effectiveSide(rule, direction) ?? 'below'
      // A sweep touches beyond the level then closes back inside it.
      const swept = side === 'below' ? snapshot.price <= rule.level : snapshot.price >= rule.level
      if (!swept) return null
      return {
        eventType,
        rule,
        conditionKey: ruleConditionKey(eventType, rule, index),
        message: `${spec.pair} swept liquidity at ${rule.level} (now ${price}).`,
        data: { rule, currentPrice: price, level: rule.level, side },
      }
    }

    case 'price_enters_zone': {
      const bounds = zoneBounds(rule)
      if (!bounds) return null
      if (price < bounds.low || price > bounds.high) return null
      return {
        eventType,
        rule,
        conditionKey: ruleConditionKey(eventType, rule, index),
        message: `${spec.pair} entered zone ${bounds.low}-${bounds.high} (now ${price}).`,
        data: { rule, currentPrice: price, ...bounds },
      }
    }

    case 'price_approaches_zone': {
      const bounds = zoneBounds(rule)
      if (!bounds) return null
      const distance = distanceToZone(price, bounds.low, bounds.high)
      const threshold = approachThreshold(rule, price, config)
      if (distance > threshold) return null
      return {
        eventType,
        rule,
        conditionKey: ruleConditionKey(eventType, rule, index),
        message: `${spec.pair} approaching zone ${bounds.low}-${bounds.high} (now ${price}).`,
        data: { rule, currentPrice: price, distance, threshold, ...bounds },
      }
    }

    default:
      return null
  }
}

/** R-multiple and unrealized-P&L checks against the frozen position block. */
function evaluateManagementRule(
  rule: WatchManagementRule,
  index: number,
  spec: WatchSpec,
  snapshot: WatchSnapshot,
): RuleHit | null {
  const position = spec.position
  if (!position) return null
  const price = snapshot.price
  const entry = position.entry
  if (!Number.isFinite(entry) || entry === 0) return null

  if (rule.type === 'unrealized_pnl_pct') {
    if (typeof rule.pct !== 'number' || !Number.isFinite(rule.pct)) return null
    const move = position.side === 'LONG' ? price - entry : entry - price
    const pct = (move / entry) * 100
    const op = rule.op ?? 'above'
    const hit = op === 'above' ? pct >= rule.pct : pct <= rule.pct
    if (!hit) return null
    return {
      eventType: 'MANAGEMENT_ALERT',
      rule: { type: 'price_breaks_level' },
      conditionKey: managementConditionKey(rule, index),
      message: `${spec.pair} unrealized P&L ${pct.toFixed(2)}% (${op} ${rule.pct}%).`,
      data: { rule, currentPrice: price, entry, pnlPct: pct, side: position.side },
    }
  }

  if (rule.type === 'r_multiple_reached') {
    if (typeof rule.multiple !== 'number' || !Number.isFinite(rule.multiple)) return null
    if (typeof position.stop !== 'number' || !Number.isFinite(position.stop)) return null
    const risk = position.side === 'LONG' ? entry - position.stop : position.stop - entry
    if (risk <= 0) return null
    const reward = position.side === 'LONG' ? price - entry : entry - price
    const rMultiple = reward / risk
    if (rMultiple < rule.multiple) return null
    return {
      eventType: 'MANAGEMENT_ALERT',
      rule: { type: 'price_breaks_level' },
      conditionKey: managementConditionKey(rule, index),
      message: `${spec.pair} reached ${rMultiple.toFixed(2)}R (target ${rule.multiple}R).`,
      data: { rule, currentPrice: price, entry, stop: position.stop, rMultiple, side: position.side },
    }
  }

  return null
}

// ==================== main entry point ====================

/**
 * Evaluate one watcher against one snapshot.
 *
 * Returns the state to persist plus any events that fired. This function never
 * throws on malformed rules — an unusable rule simply does not fire.
 */
export function evaluateWatch(
  spec: WatchSpec,
  state: WatchState,
  snapshot: WatchSnapshot,
  nowIso: string,
  config: EvaluatorConfig = DEFAULT_EVALUATOR_CONFIG,
): EvaluationResult {
  const next: WatchState = {
    ...state,
    alertedConditions: { ...state.alertedConditions },
    firedConditions: { ...state.firedConditions },
  }
  const nowMs = parseTime(nowIso) ?? Date.now()
  const previousPrice = next.lastPrice
  const events: WatchEvent[] = []

  next.pollCount += 1
  next.lastChecked = nowIso
  next.lastMarketTimestamp = snapshot.timestamp
  next.lastPrice = snapshot.price
  if (!next.armedAt) next.armedAt = nowIso

  // Refresh candle bookkeeping so status readouts and the next pass agree.
  const timeframe = primaryCandleTimeframe(spec, snapshot)
  const candles = matchingCandles(snapshot, timeframe)
  const confirmed = candles.filter((c) => c.confirmed !== false)
  next.lastConfirmedCandle = confirmed.length > 0 ? confirmed[confirmed.length - 1] : null
  next.previousConfirmedCandle = confirmed.length > 1 ? confirmed[confirmed.length - 2] : null

  const makeEvent = (
    hit: RuleHit,
    type: WatchEventType,
  ): WatchEvent => ({
    watcherId: '',
    eventType: type,
    conditionKey: hit.conditionKey,
    message: hit.message,
    price: snapshot.price,
    at: nowIso,
    data: hit.data,
  })

  const markAlerted = (key: string): void => {
    next.alertedConditions[key] = nowIso
    next.firedConditions[key] = nowIso
    next.lastEvent = 'TRIGGER_HIT'
    next.cooldownUntil = new Date(nowMs + config.cooldownSeconds * 1000).toISOString()
  }

  const cooldownActive = (): boolean => {
    const until = parseTime(next.cooldownUntil)
    return until !== null && until > nowMs
  }

  // ---- expiry ----
  const expiryMs = parseTime(spec.expiry)
  if (expiryMs !== null && nowMs >= expiryMs) {
    const key = 'EXPIRED:expiry'
    if (!next.alertedConditions[key]) {
      next.alertedConditions[key] = nowIso
      events.push({
        watcherId: '',
        eventType: 'EXPIRED',
        conditionKey: key,
        message: `${spec.pair} watcher expired.`,
        price: snapshot.price,
        at: nowIso,
        data: { expiry: spec.expiry, currentPrice: snapshot.price },
      })
    }
    next.lastEvent = 'EXPIRED'
    return { state: next, events, terminal: true }
  }

  // ---- invalidation (terminal) ----
  for (let i = 0; i < spec.invalidationRules.length; i++) {
    const hit = evaluateRule(
      spec.invalidationRules[i], i, spec, snapshot, previousPrice, next, config, 'INVALIDATED',
    )
    if (!hit || next.alertedConditions[hit.conditionKey]) continue
    const event = makeEvent(hit, 'INVALIDATED')
    next.alertedConditions[hit.conditionKey] = nowIso
    next.firedConditions[hit.conditionKey] = nowIso
    next.lastEvent = 'INVALIDATED'
    events.push(event)
    return { state: next, events, terminal: true }
  }

  // ---- triggers ----
  let firedTrigger = false
  for (let i = 0; i < spec.rules.length; i++) {
    const hit = evaluateRule(spec.rules[i], i, spec, snapshot, previousPrice, next, config, 'TRIGGER_HIT')
    if (!hit) continue
    if (next.alertedConditions[hit.conditionKey]) continue
    if (cooldownActive()) continue
    events.push(makeEvent(hit, 'TRIGGER_HIT'))
    markAlerted(hit.conditionKey)
    firedTrigger = true
  }

  // ---- management (non-terminal, cooldown-gated) ----
  for (let i = 0; i < spec.managementRules.length; i++) {
    const hit = evaluateManagementRule(spec.managementRules[i], i, spec, snapshot)
    if (!hit) continue
    if (next.alertedConditions[hit.conditionKey]) continue
    if (cooldownActive() && !firedTrigger) continue
    events.push(makeEvent(hit, 'MANAGEMENT_ALERT'))
    if (!firedTrigger) markAlerted(hit.conditionKey)
    else {
      next.alertedConditions[hit.conditionKey] = nowIso
      next.firedConditions[hit.conditionKey] = nowIso
    }
  }

  // A fired trigger leaves the watcher armed so the model can re-arm per phase.
  // Terminality is decided by the caller (invalidation/expiry) or by the model.
  return { state: next, events, terminal: false }
}

/** Convenience for a watcher that has never been evaluated. */
export function initialState(nowIso: string): WatchState {
  return emptyWatchState(nowIso)
}
