/**
 * Watcher board rendering — the persistent live card a market watcher shows in
 * an external chat (Discord today, Telegram next).
 *
 * Pure: no I/O, no clock of its own (the caller passes `nowIso`), no imports
 * from Alice's `src/`. It lives in the shared protocol package so Alice builds
 * the card once and the connector adapter renders it verbatim, which is what
 * keeps the phone surface identical to the desktop one.
 *
 * Ported from Vibe-Trading's `discord_bot.py` watcher board
 * (`_format_watcher_line`, `format_watcher_detail`, `_watcher_pulse_bar`,
 * `_requirement_bar`, `_trigger_progress`, `_watcher_candle_countdown_line`).
 * The bar grammar (filled/empty blocks), the arrow layout, and the pulse
 * thresholds are deliberately identical so operators get the readout they
 * already trust.
 */

// ==================== structural inputs ====================
// Deliberately structural rather than importing Alice's WatchSpec/WatchState:
// the connector package must not depend on Alice's internals.

export interface WatcherBoardRule {
  type: string
  id?: string
  side?: string
  level?: number
  low?: number
  high?: number
  timeframe?: string
  threshold?: number
  thresholdPct?: number
  multiple?: number
  pct?: number
  op?: string
}

export interface WatcherBoardCandle {
  timestamp: string
  open?: number
  high?: number
  low?: number
  close: number
  volume?: number | null
  timeframe?: string
  confirmed?: boolean
}

export interface WatcherBoardPosition {
  side: 'LONG' | 'SHORT'
  entry: number
  stop?: number
  targets?: number[]
  size?: number
}

export interface WatcherBoardSpec {
  pair: string
  assetClass?: string
  direction?: string
  timeframe?: string
  rules?: WatcherBoardRule[]
  invalidationRules?: WatcherBoardRule[]
  managementRules?: WatcherBoardRule[]
  position?: WatcherBoardPosition
  expiry?: string
  /** Human trigger sentence the model wrote when it armed the watcher. */
  waitingTrigger?: string
  /** Invalidation sentences, when the model wrote them as prose. */
  invalidationConditions?: string[]
}

export interface WatcherBoardState {
  armedAt?: string | null
  lastChecked?: string | null
  lastPrice?: number | null
  lastMarketTimestamp?: string | null
  /** Which source served `lastPrice`. Absent on older records. */
  lastPriceSource?: {
    kind: 'tv-feed' | 'vendor'
    ref: string
    fellBack?: boolean
  } | null
  lastConfirmedCandle?: WatcherBoardCandle | null
  previousConfirmedCandle?: WatcherBoardCandle | null
  terminal?: boolean
  pollCount?: number
  errorCount?: number
  lastError?: string | null
  backoffUntil?: string | null
  firedConditions?: Record<string, string>
}

/** Free-form plan context the model wrote alongside the rules. */
export interface WatcherBoardMeta {
  rating?: string | number | null
  grade?: string | null
  setupPhase?: string | null
  nextStep?: string | null
  stopLoss?: number | null
  targets?: number[] | string | null
}

export interface WatcherBoardEventLine {
  eventType: string
  message: string
  at?: string
  price?: number | null
}

export interface WatcherBoardInput {
  watcherId: string
  workspaceId: string
  workspaceLabel?: string
  title: string
  /** Whether the poller is alive right now, from the loop's point of view. */
  running: boolean
  /** False once the watcher reached a terminal status. */
  pollable: boolean
  pollSeconds: number
  spec: WatcherBoardSpec
  state: WatcherBoardState
  meta?: WatcherBoardMeta
  events?: WatcherBoardEventLine[]
  nowIso: string
}

/** One rendered card. Everything the chat renderer needs, nothing it derives. */
export interface WatcherBoardCard {
  watcherId: string
  workspaceId: string
  workspaceLabel?: string
  title: string
  pair: string
  terminal: boolean
  /** 0–100, for clients that draw their own bar. */
  progressPercent: number
  /** Compact one-message card body (chat markdown). */
  card: string
  /** Expanded body (chat markdown) shown when the card is toggled open. */
  detail: string
  updatedAt: string
}

// ==================== primitives ====================

const BAR_WIDTH = 12
const FILLED = '\u25B0'
const EMPTY = '\u25B1'

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** `1m` / `15m` / `4h` / `1d` / `1w` → seconds. 0 when unparseable. */
export function watcherTimeframeSeconds(value: string | undefined): number {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!raw) return 0
  const match = raw.match(/^(\d+)([mhdw])$/)
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

/** `95s` / `4m 12s` / `2h 3m` — compact, never `0h 0m 5s`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const rest = total % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

/** Prices keep their significant digits but never trailing zeros. */
export function formatPriceValue(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  const text = value.toFixed(5)
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** A filled bar that never fully fills until 100. */
export function requirementBar(percent: number, width: number = BAR_WIDTH): string {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  let filled = Math.round((pct / 100) * width)
  if (pct > 0 && filled === 0) filled = 1
  if (pct < 100) filled = Math.min(filled, Math.max(0, width - 1))
  return FILLED.repeat(filled) + EMPTY.repeat(Math.max(0, width - filled))
}

/** Animated pulse used while the poller is alive. */
export function watcherProgressBar(frame: number, width: number = BAR_WIDTH): string {
  const lit = (frame % width) + 1
  return FILLED.repeat(lit) + EMPTY.repeat(Math.max(0, width - lit))
}

export function statusDot(frame: number): string {
  return frame % 2 === 0 ? '\uD83D\uDFE2' : '\u26AB'
}

/**
 * Liveness readout: icon + bar + honest wording. A watcher that has not ticked
 * inside its cadence is `delayed`, and past 5x it is `stale` — the same
 * thresholds the phone surface used, so a stalled loop cannot look healthy.
 */
export function watcherPulseBar(input: {
  frame: number
  running: boolean
  pollable: boolean
  ageSeconds: number | null
  pollSeconds: number
}): { icon: string; bar: string } {
  const { frame, running, pollable, ageSeconds, pollSeconds } = input
  if (!running) return { icon: '\uD83D\uDD34', bar: `${EMPTY.repeat(BAR_WIDTH)} poller stopped` }
  if (!pollable) return { icon: '\uD83D\uDFE1', bar: `${FILLED.repeat(3)}${EMPTY.repeat(BAR_WIDTH - 3)} not polling this setup` }
  if (ageSeconds === null) return { icon: '\uD83D\uDFE1', bar: `${watcherProgressBar(frame)} waiting for first tick` }
  const expected = Math.max(1, pollSeconds)
  if (ageSeconds <= expected * 2) {
    return { icon: statusDot(frame), bar: `${watcherProgressBar(frame)} live \u00B7 last tick ${formatDuration(ageSeconds)} ago` }
  }
  if (ageSeconds <= expected * 5) {
    return { icon: '\uD83D\uDFE0', bar: `${FILLED.repeat(6)}${EMPTY.repeat(BAR_WIDTH - 6)} delayed \u00B7 last tick ${formatDuration(ageSeconds)} ago` }
  }
  return { icon: '\uD83D\uDD34', bar: `${FILLED.repeat(2)}${EMPTY.repeat(BAR_WIDTH - 2)} stale \u00B7 last tick ${formatDuration(ageSeconds)} ago` }
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}\u2026`
}

// ==================== trigger geometry ====================

function primaryRule(spec: WatcherBoardSpec): WatcherBoardRule {
  const first = spec.rules?.[0]
  return first && typeof first === 'object' ? first : { type: 'rule' }
}

/** True when the deciding rule is a confirmed `candle_close`. */
export function isCandleCloseTrigger(spec: WatcherBoardSpec): boolean {
  return String(primaryRule(spec).type ?? '').trim().toLowerCase() === 'candle_close'
}

/** The entry zone, from whichever rule authored one. */
export function zoneBounds(spec: WatcherBoardSpec): { low: number; high: number } | null {
  for (const rule of [...(spec.rules ?? []), ...(spec.invalidationRules ?? [])]) {
    if (typeof rule.low === 'number' && typeof rule.high === 'number') {
      return rule.low <= rule.high ? { low: rule.low, high: rule.high } : { low: rule.high, high: rule.low }
    }
  }
  return null
}

/**
 * Where price sits relative to the entry zone: `inside entry zone (x)` /
 * `<d> above zone` / `<d> below zone`. `-` when there is no usable zone.
 * Mirrors Vibe-Trading's `_zone_position`, so the desktop panel reads the same
 * as the card it was ported from.
 */
export function zonePosition(
  price: number | null,
  zone: { low: number; high: number } | null,
): string {
  if (price === null || !zone) return '-'
  if (price >= zone.low && price <= zone.high) return `inside entry zone (${formatPriceValue(price)})`
  return price > zone.high
    ? `${formatPriceValue(price - zone.high)} above zone`
    : `${formatPriceValue(zone.low - price)} below zone`
}

/**
 * Where the trigger sits: `[target, humanText]`. A rule with a level wins;
 * otherwise the entry zone, otherwise the authored trigger prose.
 */
export function watcherTriggerTarget(spec: WatcherBoardSpec): [string, string] {
  const rules = spec.rules ?? []
  const zone = zoneBounds(spec)
  if (rules.length === 0) {
    const prose = spec.waitingTrigger || '-'
    if (zone) return [`${zone.low}-${zone.high}`, prose]
    return ['-', prose]
  }
  const rule = rules[0] ?? { type: 'rule' }
  const ruleType = String(rule.type ?? 'rule').trim().toLowerCase()
  let side = String(rule.side ?? '').trim()
  const level = rule.level
  if (typeof level === 'number' && Number.isFinite(level)) {
    if (!side && ruleType === 'level_reclaim') side = 'above'
    else if (!side && ruleType === 'level_breakdown') side = 'below'
    else if (!side && ruleType === 'candle_close') side = spec.direction === 'SHORT' ? 'below' : 'above'
    const label = side === 'above' ? 'above' : side === 'below' ? 'below' : side || 'at'
    const timeframe = String(rule.timeframe ?? spec.timeframe ?? '').trim()
    if (ruleType === 'candle_close') {
      const prefix = timeframe ? `${timeframe} candle close` : 'candle close'
      return [String(level), `${prefix} ${label} ${level}`]
    }
    const suffix = timeframe ? ` on ${timeframe}` : ''
    return [String(level), `price ${label} ${level}${suffix}`]
  }
  if (ruleType === 'price_enters_zone' || ruleType === 'price_approaches_zone' || ruleType === 'zone' || ruleType === 'entry_zone') {
    const low = rule.low ?? zone?.low
    const high = rule.high ?? zone?.high
    if (typeof low === 'number' && typeof high === 'number') {
      return [`${low}-${high}`, `price enters ${low}-${high}`]
    }
  }
  return ['-', spec.waitingTrigger || ruleType]
}

/** Which side of the level counts as the trigger, defaulting from direction. */
export function watcherTriggerSide(spec: WatcherBoardSpec): string {
  const rule = primaryRule(spec)
  const ruleType = String(rule.type ?? '').trim().toLowerCase()
  const side = String(rule.side ?? '').trim().toLowerCase()
  if (side === 'above' || side === 'below') return side
  if (ruleType === 'level_reclaim') return 'above'
  if (ruleType === 'level_breakdown') return 'below'
  const direction = String(spec.direction ?? '').trim().toUpperCase()
  if (direction === 'SHORT' && typeof rule.level === 'number') return 'below'
  if (direction === 'LONG' && typeof rule.level === 'number') return 'above'
  return ''
}

/**
 * Basis price for a candle trigger; the live price otherwise.
 *
 * A candle rule only FIRES on a confirmed close, but its PROGRESS must track
 * the forming candle — whose close is the latest price. Anchoring progress on
 * `lastConfirmedCandle` read as a frozen 0% bar whenever price sat on the level
 * while the previous close was far away: distance was measured from the wrong
 * price, and with no entry zone the fallback reference is only 0.1% of the
 * level, so any real gap clamped to exactly 0.
 *
 * The confirmed close is still consulted, but for the FIRED question rather
 * than the distance one — see `confirmedCandleCrossed`.
 */
export function candleCloseBasis(
  spec: WatcherBoardSpec,
  state: WatcherBoardState,
  fallback: number | null,
): number | null {
  if (!isCandleCloseTrigger(spec)) return fallback
  if (typeof fallback === 'number') return fallback
  const candle = state.lastConfirmedCandle
  if (candle && typeof candle.close === 'number') return candle.close
  return null
}

/**
 * True when the last CONFIRMED candle already closed beyond the level.
 *
 * This is the only thing that can legitimately reach 100% for a candle rule.
 * It is checked against the confirmed candle rather than the live price on
 * purpose: a live price beyond the level is a forming candle that may still
 * close back inside, so it is progress (99%), not a fire.
 */
function confirmedCandleCrossed(
  spec: WatcherBoardSpec,
  state: WatcherBoardState,
  target: string,
  side: string,
): boolean {
  if (!isCandleCloseTrigger(spec)) return false
  const candle = state.lastConfirmedCandle
  if (!candle || typeof candle.close !== 'number') return false
  return triggerCrossed(candle.close, target, side)
}

function triggerCrossed(price: number | null, target: string, side: string): boolean {
  if (price === null) return false
  const level = Number.parseFloat(target)
  if (!Number.isFinite(level)) return false
  if (side === 'below') return price <= level
  if (side === 'above') return price >= level
  return false
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(99, Math.round(value)))
}

/**
 * A real baseline for a watcher that has no usable entry zone.
 *
 * Without this the fallback reference was 0.1% of the level, so anything more
 * than a hair away clamped to a flat 0% — a watcher whose price sat 0.45% from
 * its trigger read exactly the same as one that had not moved at all.
 *
 * The last confirmed close is the honest anchor: it is where price started this
 * leg, so "how far has price travelled from there toward the trigger" is a real
 * gradient. It is only usable when it sits on the NEAR side of the level — a
 * close already beyond the level is a fired trigger, not progress.
 */
function anchorForSide(side: string, level: number, anchor: number | null): number | null {
  if (anchor === null || !Number.isFinite(anchor) || anchor === level) return null
  if (side === 'below') return anchor > level ? anchor : null
  return anchor < level ? anchor : null
}

function fallbackPercent(
  zone: { low: number; high: number } | null,
  level: number,
  price: number,
  anchor: number | null,
): number {
  const width = zone ? Math.abs(zone.high - zone.low) : 0
  // The smallest span that still reads as real travel. 0.1% of the level is the
  // same reference the no-anchor branch below uses.
  const reference = Math.max(width, Math.abs(level) * 0.001, 0.00001)

  if (anchor !== null) {
    // Fraction of the way from the anchor to the level: `1 - remaining/total`.
    // Expressed as a ratio of distances rather than a signed difference so the
    // SAME line works for an upward and a downward approach — a signed form
    // silently rejected every `below` watcher, whose span and travel are both
    // negative.
    const total = Math.abs(level - anchor)
    // A last confirmed close that sits essentially ON the level is not a usable
    // baseline: `total` collapses toward zero, so any real remaining distance
    // clamps to a flat 0% even when price is a hair from the trigger. Only a
    // span at least as wide as the reference can express progress; otherwise
    // fall through to measuring proximity to the level itself.
    if (total >= reference) {
      const remaining = Math.abs(level - price)
      return clampPercent((1 - remaining / total) * 100)
    }
  }

  return clampPercent((1 - Math.abs(level - price) / reference) * 100)
}

/**
 * How close the market is to the trigger: percentage plus the two sentences the
 * card prints under the bar. Distance is measured from the near edge of the
 * entry zone when one exists, so the bar communicates real progress rather than
 * a raw ratio to zero.
 */
export function watcherTriggerProgress(
  spec: WatcherBoardSpec,
  state: WatcherBoardState,
  livePrice: number | null,
  target: string,
  side: string,
): { percent: number; text: string; need: string; basisPrice: number | null } {
  const price = candleCloseBasis(spec, state, livePrice)
  if (price === null) return { percent: 0, text: 'progress unavailable', need: 'need current price', basisPrice: null }

  const zone = zoneBounds(spec)
  // A hyphenated target (`113-115.6`) is the ZONE marker, not a number. Detect
  // it BEFORE parseFloat: `Number.parseFloat('113-115.6')` silently returns
  // `113`, which routed a zone watcher into the scalar-level branch and printed
  // `trigger reached` whenever price merely sat above the zone's lower edge.
  // Vibe-Trading guards this with `"-" in str(target)`; the TS port must too.
  const zoneTarget = target === '-' || target.includes('-')

  if (zoneTarget) {
    if (!zone) return { percent: 0, text: 'progress unavailable', need: 'need a valid entry zone', basisPrice: price }
    const { low, high } = zone
    if (price >= low && price <= high) {
      return { percent: 100, text: 'entry zone reached', need: 'price is inside the watched zone', basisPrice: price }
    }
    const distance = price < low ? low - price : price - high
    const width = Math.max(0.00001, high - low)
    const reference = Math.max(width, Math.abs(price) * 0.005, 0.00001)
    const percent = clampPercent((1 - distance / reference) * 100)
    const text = price < low ? `${percent}% to entry zone` : `${percent}% back to entry zone`
    const need = price < low ? `need +${formatPriceValue(distance)}` : `need -${formatPriceValue(distance)}`
    return { percent, text, need, basisPrice: price }
  }

  const numericTarget = Number.parseFloat(target)
  if (!Number.isFinite(numericTarget)) {
    return { percent: 0, text: 'progress unavailable', need: 'need a numeric trigger target', basisPrice: price }
  }

  // A candle watcher fires only on a CONFIRMED close, so a live price beyond
  // the level is a FORMING candle, not a fired trigger. This must be checked
  // BEFORE the 100% returns below: reporting `trigger reached` for a candle
  // that has not closed claims a fire that never happened, and it made the
  // `forming candle beyond trigger` state unreachable.
  if (isCandleCloseTrigger(spec) && triggerCrossed(price, target, side)) {
    // 100% is reserved for a CONFIRMED close beyond the level; a forming candle
    // that is merely beyond it sits at 99% and says why, because it can still
    // close back inside and never fire.
    return confirmedCandleCrossed(spec, state, target, side)
      ? {
          percent: 100,
          text: 'confirmed candle trigger reached',
          need: side === 'below' ? 'price is at or below trigger' : 'price is at or above trigger',
          basisPrice: price,
        }
      : {
          percent: 99,
          text: 'forming candle beyond trigger',
          need: 'needs confirmed candle close',
          basisPrice: price,
        }
  }

  const zoneEdge = side === 'below'
    ? (zone ? zone.high : null)
    : (zone ? zone.low : null)
  const confirmedClose = state.lastConfirmedCandle
  const rawAnchor = confirmedClose && typeof confirmedClose.close === 'number'
    ? confirmedClose.close
    : null
  const anchor = anchorForSide(side, numericTarget, rawAnchor)

  let percent: number
  let text: string
  let need: string

  if (side === 'below') {
    if (price <= numericTarget) {
      return { percent: 100, text: 'breakdown trigger reached', need: 'price is at or below trigger', basisPrice: price }
    }
    const start = zoneEdge !== null && zoneEdge > numericTarget ? zoneEdge : null
    percent = start === null
      ? fallbackPercent(zone, numericTarget, price, anchor)
      : clampPercent(((start - price) / Math.max(0.00001, start - numericTarget)) * 100)
    text = `${percent}% to breakdown`
    need = `need -${formatPriceValue(price - numericTarget)}`
  } else {
    if (price >= numericTarget) {
      return { percent: 100, text: 'trigger reached', need: 'price is at or above trigger', basisPrice: price }
    }
    const start = zoneEdge !== null && zoneEdge < numericTarget ? zoneEdge : null
    percent = start === null
      ? fallbackPercent(zone, numericTarget, price, anchor)
      : clampPercent(((price - start) / Math.max(0.00001, numericTarget - start)) * 100)
    text = `${percent}% to trigger`
    need = `need +${formatPriceValue(numericTarget - price)}`
  }

  // A candle bar measures how close the FORMING candle is to closing beyond the
  // level, so say that rather than a bare "trigger": only the close can fire the
  // watcher, and the two events must not read as the same thing.
  if (isCandleCloseTrigger(spec)) {
    const candleText = text.includes('to breakdown')
      ? text.replace('to breakdown', 'to confirmed breakdown')
      : text.includes('to trigger')
        ? text.replace('to trigger', 'to confirmed close')
        : text
    return { percent, text: candleText, need, basisPrice: price }
  }
  return { percent, text, need, basisPrice: price }
}

/** `0.00123 below trigger` / `inside target zone` — the raw distance line. */
export function distanceToTrigger(
  price: number | null,
  target: string,
  zone: { low: number; high: number } | null,
  side: string,
): string {
  if (price === null || !target || target === '-') return '-'
  // Same zone-marker guard as `watcherTriggerProgress`: parseFloat would read
  // `113-115.6` as `113` and print a raw level gap instead of the distance to
  // the zone edge.
  if (target.includes('-')) {
    if (!zone) return '-'
    if (price >= zone.low && price <= zone.high) return 'inside target zone'
    return price < zone.low
      ? `${formatPriceValue(zone.low - price)} below zone`
      : `${formatPriceValue(price - zone.high)} above zone`
  }
  const numericTarget = Number.parseFloat(target)
  if (!Number.isFinite(numericTarget)) return '-'
  const distance = numericTarget - price
  if (Math.abs(distance) < 0.00001) return 'at target'
  let label: string
  if (side === 'below') label = price > numericTarget ? 'above breakdown' : 'below breakdown'
  else if (side === 'above') label = price < numericTarget ? 'below trigger' : 'above trigger'
  else label = distance > 0 ? 'below target' : 'above target'
  return `${formatPriceValue(Math.abs(distance))} ${label}`
}

/** Candle bookkeeping line for a `candle_close` watcher. Empty otherwise. */
export function watcherCandleTrackingLine(
  spec: WatcherBoardSpec,
  state: WatcherBoardState,
  target: string,
  side: string,
): string {
  if (!isCandleCloseTrigger(spec)) return ''
  const rule = primaryRule(spec)
  const timeframe = String(rule.timeframe ?? spec.timeframe ?? '').trim()
  const timeframeText = timeframe ? `${timeframe} ` : ''
  const label = side === 'above' ? 'above' : side === 'below' ? 'below' : 'at'
  const level = Number.parseFloat(target)
  const lastCandle = state.lastConfirmedCandle
  const previous = state.previousConfirmedCandle
  if (lastCandle && typeof lastCandle.close === 'number' && lastCandle.confirmed === false) {
    const confirmedClose = previous ? formatPriceValue(previous.close) : '-'
    return `\uD83D\uDD6F\uFE0F **Candle tracking**: forming \`${timeframeText}close ${formatPriceValue(lastCandle.close)}\` \u00B7 last confirmed \`${confirmedClose}\` \u00B7 waits for confirmed close ${label} \`${formatPriceValue(level)}\``
  }
  if (lastCandle && typeof lastCandle.close === 'number') {
    return `\uD83D\uDD6F\uFE0F **Candle tracking**: last confirmed \`${timeframeText}close ${formatPriceValue(lastCandle.close)}\` \u00B7 waits for confirmed close ${label} \`${formatPriceValue(level)}\``
  }
  return `\uD83D\uDD6F\uFE0F **Candle tracking**: waiting for \`${timeframeText}confirmed close\` data`
}

/** Time left in the candle that will decide a `candle_close` watcher. */
export function watcherCandleCountdownLine(
  spec: WatcherBoardSpec,
  state: WatcherBoardState,
  nowIso: string,
): string {
  if (!isCandleCloseTrigger(spec)) return ''
  const rule = primaryRule(spec)
  const timeframe = String(rule.timeframe ?? spec.timeframe ?? '').trim()
  const seconds = watcherTimeframeSeconds(timeframe)
  if (seconds <= 0) return ''
  const now = parseIso(nowIso) ?? Date.now()
  const market = parseIso(state.lastMarketTimestamp)
  const anchor = market ?? now
  const elapsed = Math.floor(anchor / 1000) % seconds
  let remaining = seconds - (elapsed || seconds)
  if (market !== null) {
    const drift = Math.max(0, Math.floor((now - market) / 1000))
    remaining = Math.max(0, remaining - drift)
  }
  if (remaining <= 0) {
    return `\u23F3 **Candle timer**: \`${timeframe}\` close is due now \u00B7 waiting for confirmed candle data`
  }
  return `\u23F3 **Candle timer**: \`${timeframe}\` closes in \`${formatDuration(remaining)}\``
}

// ==================== labels ====================

const RULE_LABELS: Record<string, string> = {
  price_breaks_level: 'Price breaks level',
  price_crosses_level: 'Price crosses level',
  candle_close: 'Candle close',
  level_reclaim: 'Level reclaim',
  level_breakdown: 'Level breakdown',
  liquidity_sweep_touched: 'Liquidity sweep',
  price_enters_zone: 'Price enters zone',
  price_approaches_zone: 'Price approaches zone',
  r_multiple_reached: 'R multiple',
  unrealized_pnl_pct: 'Unrealized P&L',
}

/** Human label for one rule, with its discriminating fields folded in. */
export function describeRule(rule: WatcherBoardRule, fallbackTimeframe?: string): string {
  const label = RULE_LABELS[rule.type] ?? rule.type
  if (rule.type === 'candle_close') {
    const tf = rule.timeframe ?? fallbackTimeframe ?? ''
    return `${label} \u00B7 ${tf} ${rule.side ?? ''} ${rule.level ?? ''}`.trim()
  }
  if (rule.type === 'price_enters_zone' || rule.type === 'price_approaches_zone') {
    return `${label} \u00B7 ${rule.low ?? '?'}\u2013${rule.high ?? '?'}`
  }
  if (rule.type === 'r_multiple_reached') return `${label} \u00B7 ${rule.multiple ?? '?'}R`
  if (rule.type === 'unrealized_pnl_pct') return `${label} \u00B7 ${rule.op ?? ''} ${rule.pct ?? '?'}%`.trim()
  if (typeof rule.level === 'number') return `${label} \u00B7 ${rule.side ?? ''} ${rule.level}`.trim()
  return label
}

function targetsText(value: number[] | string | null | undefined): string {
  if (Array.isArray(value)) return value.length > 0 ? value.map((item) => formatPriceValue(item)).join(', ') : '-'
  if (typeof value === 'string') return value.trim() || '-'
  return '-'
}

function eventTimeOrPrice(event: WatcherBoardEventLine): string {
  if (typeof event.price === 'number') return `price \`${formatPriceValue(event.price)}\``
  const parsed = parseIso(event.at)
  if (parsed !== null) return `time \`${new Date(parsed).toISOString().slice(11, 19)} UTC\``
  return 'time `-`'
}

// ==================== card renderer ====================

/**
 * Render one watcher into the two chat bodies the board sends: a compact
 * `card` line and the full `detail` panel. `frame` drives the pulse animation,
 * so a caller that re-renders on a timer gets a visibly live bar.
 *
 * Pure and total: a watcher with no state yet renders a `waiting for first
 * tick` card rather than throwing, because the board polls before the loop's
 * first pass.
 */
export function renderWatcherBoardCard(input: WatcherBoardInput, frame = 0): WatcherBoardCard {
  const { spec, state, meta = {}, nowIso } = input
  const terminalState = state.terminal === true
  const zone = zoneBounds(spec)
  const zoneText = zone ? `${formatPriceValue(zone.low)}-${formatPriceValue(zone.high)}` : '-'
  const status = terminalState ? 'terminal' : input.pollable ? 'active' : 'idle'
  const statusLabel = status === 'terminal' ? 'FINISHED' : status === 'active' ? 'WATCHING' : 'PAUSED'
  const currentPrice = typeof state.lastPrice === 'number' ? state.lastPrice : null
  const [target, triggerText] = watcherTriggerTarget(spec)
  const side = watcherTriggerSide(spec)
  const progress = watcherTriggerProgress(spec, state, currentPrice, target, side)
  const distance = distanceToTrigger(progress.basisPrice, target, zone, side)
  const bar = requirementBar(progress.percent)
  const lastCheckedMs = parseIso(state.lastChecked)
  const nowMs = parseIso(nowIso) ?? Date.now()
  const ageSeconds = lastCheckedMs === null ? null : Math.max(0, (nowMs - lastCheckedMs) / 1000)
  const { icon, bar: pulse } = watcherPulseBar({
    frame,
    running: input.running,
    pollable: input.pollable && !terminalState,
    ageSeconds,
    pollSeconds: input.pollSeconds,
  })
  const marketMs = parseIso(state.lastMarketTimestamp)
  const marketText = marketMs === null ? '-' : `${new Date(marketMs).toISOString().slice(11, 19)} UTC`
  const lastTick = ageSeconds === null ? '-' : `${formatDuration(ageSeconds)} ago`
  // Say WHICH feed served the price. A bare number cannot distinguish a live
  // push quote from a delayed vendor bar, and an operator (or an agent asked to
  // verify) would otherwise have to guess — which is exactly how a live watcher
  // gets reported as delayed.
  const source = state.lastPriceSource ?? null
  const sourceText = source === null
    ? 'src ?'
    : source.kind === 'tv-feed'
      ? 'src LIVE'
      : source.fellBack
        ? 'src delayed (live unavailable)'
        : 'src delayed'
  const direction = String(spec.direction ?? '').trim().toUpperCase() || '-'
  const setupPhase = meta.setupPhase ?? status.toUpperCase()
  const quality = meta.rating ?? meta.grade ?? 'not graded'
  const candleCountdown = watcherCandleCountdownLine(spec, state, nowIso)

  const workspace = input.workspaceLabel ? `\u00B7 ${input.workspaceLabel} ` : ''
  const card = [
    `${icon} **${spec.pair || '-'}** \`${input.watcherId}\` ${workspace}${direction} ${statusLabel}`,
    `\`${pulse}\``,
    `\uD83D\uDCB9 \`${formatPriceValue(currentPrice)}\` \u2192 \uD83C\uDFAF \`${target}\` (\`${distance}\`) \u00B7 tick \`#${state.pollCount ?? 0}\` \u00B7 last \`${lastTick}\` \u00B7 market \`${marketText}\` \u00B7 \`${sourceText}\``,,
    `\uD83C\uDFAF \`${bar}\` ${progress.text} \u00B7 ${progress.need}`,
    `${candleCountdown ? `${candleCountdown}\n` : ''}\uD83E\uDDED ${truncate(triggerText, 120)}`,
    `\uD83E\uDDF1 Zone \`${zoneText}\` \u00B7 \uD83E\uDDEC \`${setupPhase}\` \u00B7 \u2B50 \`${quality}\``,
  ].join('\n')

  const invalidation = (spec.invalidationConditions?.length ? spec.invalidationConditions : (spec.invalidationRules ?? []).map((rule) => describeRule(rule, spec.timeframe)))
  const stopLoss = meta.stopLoss
  const management = (spec.managementRules ?? []).map((rule) => describeRule(rule, spec.timeframe))
  const plainStatus = terminalState
    ? 'TRIGGER HIT \u2014 this watcher has finished.'
    : 'WATCHING \u2014 waiting for the trigger condition.'
  const candleTracking = watcherCandleTrackingLine(spec, state, target, side)
  const recent = (input.events ?? []).slice(-3)

  const detailLines = [
    `${icon} **${spec.pair || '-'} Watcher** \`${input.watcherId}\`${input.workspaceLabel ? ` \u00B7 ${input.workspaceLabel}` : ''}`,
    `\`${pulse}\``,
    '',
    `\uD83D\uDCE1 **Status**: ${plainStatus}`,
    `\uD83C\uDFAF **Trigger progress**: \`${bar}\` ${progress.text} \u00B7 ${progress.need}`,
    `\uD83D\uDCB9 **Current polled price**: \`${formatPriceValue(currentPrice)}\``,
    `\uD83C\uDFAF **Trigger target**: \`${target}\` \u00B7 \`${distance}\``,
    `\uD83D\uDCCD **Price location**: \`${zonePosition(currentPrice, zone)}\``,
    `\uD83E\uDDED **Watching for**: ${truncate(triggerText, 260)}`,
    ...(meta.nextStep ? [`\u27A1\uFE0F **Next after alert**: ${truncate(meta.nextStep, 260)}`] : []),
    `\uD83E\uDDA0 **Watcher tick**: \`#${state.pollCount ?? 0}\` \u00B7 last tick \`${lastTick}\``,
    '',
    `\uD83E\uDDF1 **Entry zone**: \`${zoneText}\``,
    `\uD83D\uDED1 **Invalid if**: ${truncate(invalidation.join('; ') || '-', 220)}`,
    `\uD83C\uDFC1 **Stop / targets**: \`${stopLoss ?? '-'}\` / \`${targetsText(meta.targets)}\``,
    `\uD83D\uDCC8 **Direction / TF**: \`${direction}\` / \`${spec.timeframe ?? '-'}\``,
    `\uD83E\uDDEC **Setup phase**: \`${setupPhase}\``,
    `\u2B50 **Quality**: \`${quality}\``,
    ...(management.length > 0 ? [`\uD83D\uDD27 **Management**: ${management.join('; ')}`] : []),
    '',
    `\u2699\uFE0F **Poller**: \`${input.running ? 'running' : 'stopped'}\` \u00B7 every \`${input.pollSeconds}s\` \u00B7 \`${state.pollCount ?? 0}\` ticks`,
    `\uD83D\uDD6F\uFE0F **Market data timestamp**: \`${marketText}\``,
    ...(candleTracking ? [candleTracking] : []),
    ...(candleCountdown ? [candleCountdown] : []),
  ]
  if (state.lastError) {
    detailLines.push(`\uD83D\uDCE6 Data feed ERROR x${state.errorCount ?? 1}: ${truncate(state.lastError, 150)}`)
  }
  if (recent.length > 0) {
    detailLines.push('', '\uD83D\uDD52 **Recent events**')
    for (const event of recent) {
      detailLines.push(`- ${event.eventType} \u00B7 ${eventTimeOrPrice(event)} \u00B7 ${truncate(event.message, 120)}`)
    }
  }

  return {
    watcherId: input.watcherId,
    workspaceId: input.workspaceId,
    ...(input.workspaceLabel ? { workspaceLabel: input.workspaceLabel } : {}),
    title: input.title,
    pair: spec.pair,
    terminal: terminalState,
    progressPercent: progress.percent,
    card: card.trim(),
    detail: detailLines.join('\n').trim(),
    updatedAt: nowIso,
  }
}

