/**
 * Zod schema for the Issue `watch:` frontmatter block.
 *
 * Kept beside the evaluator so the authored shape and the evaluated shape
 * cannot drift. `declaration.ts` imports this into the Issue frontmatter
 * schema; `mutate.ts` re-serializes whatever passes here.
 *
 * Rule grammar is ported from Vibe-Trading's `watcher_manager` tool so an agent
 * that learned that surface transfers without relearning.
 */

import { z } from 'zod'

import { MIN_CANDLE_TIMEFRAME_SECONDS, type WatchAssetClass } from './types.js'
import { SUPPORTED_BAR_INTERVALS, validateWatchPair } from './snapshot.js'

const TIMEFRAME_ALIASES: Record<string, string> = {
  '1min': '1m', '1minute': '1m',
  '5min': '5m', '5minute': '5m',
  '15min': '15m', '15minute': '15m',
  '30min': '30m', '30minute': '30m',
  '1hr': '1h', '1hour': '1h',
  '4hr': '4h', '4hour': '4h',
  '1day': '1d', 'daily': '1d',
}

/** Seconds per timeframe label, or 0 when unparseable. */
export function parseTimeframeSeconds(value: string): number {
  const raw = value.trim().toLowerCase().replace(/\s+/g, '')
  if (!raw) return 0
  const normalized = TIMEFRAME_ALIASES[raw] ?? raw
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

/** A candle timeframe must be 1m or larger; 30s candles are unreliable. */
export function isSupportedCandleTimeframe(value: string): boolean {
  const seconds = parseTimeframeSeconds(value)
  return seconds >= MIN_CANDLE_TIMEFRAME_SECONDS
}

/** A timeframe must ALSO be one the federated bar layer can serve. Without this
 *  a `2h` watcher would validate and then fail every fetch forever, logging an
 *  error each tick while never firing. Rejecting it up front makes the mistake
 *  visible at authoring time instead. */
export function isServableBarInterval(value: string): boolean {
  const raw = value.trim().toLowerCase().replace(/\s+/g, '')
  return (SUPPORTED_BAR_INTERVALS as readonly string[]).includes(TIMEFRAME_ALIASES[raw] ?? raw)
}

const timeframeSchema = z.string().min(1)
  .refine(isSupportedCandleTimeframe, {
    message: 'timeframe must be 1m or larger (30s candles are not reliable)',
  })
  .refine(isServableBarInterval, {
    message: `timeframe must be one of: ${SUPPORTED_BAR_INTERVALS.join(', ')}`,
  })

const sideSchema = z.enum(['above', 'below'])

const RULE_TYPES = [
  'price_breaks_level',
  'price_crosses_level',
  'candle_close',
  'level_reclaim',
  'level_breakdown',
  'liquidity_sweep_touched',
  'price_enters_zone',
  'price_approaches_zone',
] as const

/** One deterministic trigger or invalidation rule. */
export const watchRuleSchema = z.object({
  type: z.enum(RULE_TYPES),
  id: z.string().min(1).max(64).optional(),
  side: sideSchema.optional(),
  level: z.number().finite().optional(),
  low: z.number().finite().optional(),
  high: z.number().finite().optional(),
  timeframe: timeframeSchema.optional(),
  threshold: z.number().finite().nonnegative().optional(),
  thresholdPct: z.number().finite().nonnegative().optional(),
}).superRefine((rule, ctx) => {
  const needsLevel = rule.type === 'price_breaks_level'
    || rule.type === 'price_crosses_level'
    || rule.type === 'candle_close'
    || rule.type === 'level_reclaim'
    || rule.type === 'level_breakdown'
    || rule.type === 'liquidity_sweep_touched'
  if (needsLevel && typeof rule.level !== 'number') {
    ctx.addIssue({ code: 'custom', path: ['level'], message: `${rule.type} requires a numeric level` })
  }
  const needsZone = rule.type === 'price_enters_zone' || rule.type === 'price_approaches_zone'
  if (needsZone && (typeof rule.low !== 'number' || typeof rule.high !== 'number')) {
    ctx.addIssue({ code: 'custom', path: ['low'], message: `${rule.type} requires numeric low and high` })
  }
  if (rule.type === 'candle_close' && !rule.timeframe) {
    ctx.addIssue({ code: 'custom', path: ['timeframe'], message: 'candle_close requires a timeframe' })
  }
  if (rule.type === 'candle_close' && !rule.side) {
    ctx.addIssue({ code: 'custom', path: ['side'], message: 'candle_close requires a side (above or below)' })
  }
})

export const watchManagementRuleSchema = z.object({
  type: z.enum(['r_multiple_reached', 'unrealized_pnl_pct']),
  id: z.string().min(1).max(64).optional(),
  multiple: z.number().finite().positive().optional(),
  pct: z.number().finite().optional(),
  op: sideSchema.optional(),
}).superRefine((rule, ctx) => {
  if (rule.type === 'r_multiple_reached' && typeof rule.multiple !== 'number') {
    ctx.addIssue({ code: 'custom', path: ['multiple'], message: 'r_multiple_reached requires a positive multiple' })
  }
  if (rule.type === 'unrealized_pnl_pct' && typeof rule.pct !== 'number') {
    ctx.addIssue({ code: 'custom', path: ['pct'], message: 'unrealized_pnl_pct requires a numeric pct' })
  }
})

/** Frozen position context so management rules never query another process. */
export const watchPositionSchema = z.object({
  side: z.enum(['LONG', 'SHORT']),
  entry: z.number().finite(),
  stop: z.number().finite().optional(),
  targets: z.array(z.number().finite()).max(10).optional(),
  size: z.number().finite().optional(),
})

export const watchAssetClassSchema = z.enum(['crypto', 'forex', 'equity', 'commodity', 'index'])

/**
 * Plan context the model authors ALONGSIDE the deterministic rules.
 *
 * These are presentation only — the evaluator never reads them. They live UNDER
 * `watch:` rather than beside it so they re-arm with the phase they describe: a
 * grade for a setup that no longer exists would be actively misleading.
 *
 * Deliberately excluded from `specFingerprint` (see loop.ts): changing a grade
 * must NOT reset fired-condition history and replay an alert.
 */
export const watchMetaSchema = z.object({
  /** Setup quality, e.g. `A+`. */
  grade: z.string().min(1).max(32).optional(),
  /** Numeric rating, when the model uses a scale instead of a letter. */
  rating: z.union([z.string().max(32), z.number().finite()]).optional(),
  /** Which phase of the plan this watcher is watching, e.g. `reclaim`. */
  phase: z.string().min(1).max(120).optional(),
  /** What the woken Session should do after the alert. */
  nextStep: z.string().min(1).max(500).optional(),
  /** Human trigger sentence, so the card reads without the rule table. */
  waitingTrigger: z.string().min(1).max(500).optional(),
  /** Invalidation sentences, when written as prose rather than rules. */
  invalidationConditions: z.array(z.string().min(1).max(500)).max(20).optional(),
})

/** The full `watch:` block. */
export const watchSpecSchema = z.object({
  pair: z.string().min(1).max(64),
  assetClass: watchAssetClassSchema.default('crypto'),
  direction: z.enum(['LONG', 'SHORT', '']).default(''),
  timeframe: timeframeSchema,
  rules: z.array(watchRuleSchema).max(32).default([]),
  invalidationRules: z.array(watchRuleSchema).max(32).default([]),
  managementRules: z.array(watchManagementRuleSchema).max(32).default([]),
  position: watchPositionSchema.optional(),
  expiry: z.string().min(1).optional(),
  /** Presentation context shown on the watcher board card. */
  meta: watchMetaSchema.optional(),
}).superRefine((spec, ctx) => {
  // Authoring guard: reject a pair the watcher cannot price, with a correction.
  // This is the mistake that produced `pair: "yfinance|SOLUSD"` and an endless
  // "symbol may be delisted" warn — see validateWatchPair for the rationale.
  const pairVerdict = validateWatchPair(spec.pair, spec.assetClass)
  if (!pairVerdict.ok) {
    ctx.addIssue({ code: 'custom', path: ['pair'], message: pairVerdict.error })
  }
  if (spec.rules.length === 0 && spec.managementRules.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['rules'],
      message: 'a watch needs at least one trigger rule or management rule',
    })
  }
  if (spec.managementRules.length > 0 && !spec.position) {
    ctx.addIssue({
      code: 'custom',
      path: ['position'],
      message: 'managementRules require a position block (side, entry, and stop for R-multiples)',
    })
  }
  if (spec.expiry) {
    const ms = Date.parse(spec.expiry.replace(/Z$/, '+00:00'))
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: 'custom', path: ['expiry'], message: 'expiry must be an ISO timestamp' })
    }
  }
})

export type WatchSpecInput = z.input<typeof watchSpecSchema>
export type WatchSpecParsed = z.output<typeof watchSpecSchema>

/** Narrow an arbitrary asset-class string without a cast. */
export function isWatchAssetClass(value: string): value is WatchAssetClass {
  return (['crypto', 'forex', 'equity', 'commodity', 'index'] as const).includes(value as WatchAssetClass)
}
