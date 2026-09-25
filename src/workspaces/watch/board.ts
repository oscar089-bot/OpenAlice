/**
 * Watcher board projection — turns a resolved watch + its persisted state into
 * the transport-neutral card the connector package renders.
 *
 * This is the ONLY place that bridges Alice's watch domain into the shared
 * `@traderalice/connector-protocol` board types, so the loop stays pure and the
 * connector never learns Alice's internals. The renderer itself lives in the
 * protocol package and is shared verbatim with the desktop UI.
 *
 * What is deliberately NOT projected: `rating` / `grade` / free-form analysis
 * prose. Alice's watch spec carries no such field, and inventing one from the
 * Issue markdown would make the card claim something the watcher never
 * evaluated. Only facts the evaluator actually produced are shown.
 */

import type { WatcherBoardItem, WatcherBoardSpec } from '@traderalice/connector-protocol'

import type { IssueRecord } from '../issues/declaration.js'
import type { WorkspaceMeta } from '../workspace-registry.js'

import type { WatchSpec, WatchState } from './types.js'

/** Default board refresh cadence handed to the connector for its local pulse
 *  animation. Matches the watch loop interval so the bar's `live` threshold and
 *  the real tick cadence agree. */
export const DEFAULT_BOARD_REFRESH_SECONDS = 5

/** Watcher statuses that stay on the board. A fired watcher remains visible so
 *  the operator sees WHY it left the armed state; it disappears when the model
 *  rewrites the Issue (re-arming) or marks it done. */
function isBoardVisible(issue: IssueRecord): boolean {
  return issue.status !== 'done' && issue.status !== 'canceled'
}

/** Map the authored watch spec onto the renderer's structural shape. */
export function toBoardSpec(spec: WatchSpec): WatcherBoardSpec {
  return {
    pair: spec.pair,
    assetClass: spec.assetClass,
    direction: spec.direction,
    timeframe: spec.timeframe,
    rules: spec.rules.map((rule) => ({
      type: rule.type,
      ...(rule.id ? { id: rule.id } : {}),
      ...(rule.side ? { side: rule.side } : {}),
      ...(typeof rule.level === 'number' ? { level: rule.level } : {}),
      ...(typeof rule.low === 'number' ? { low: rule.low } : {}),
      ...(typeof rule.high === 'number' ? { high: rule.high } : {}),
      ...(rule.timeframe ? { timeframe: rule.timeframe } : {}),
      ...(typeof rule.threshold === 'number' ? { threshold: rule.threshold } : {}),
      ...(typeof rule.thresholdPct === 'number' ? { thresholdPct: rule.thresholdPct } : {}),
    })),
    invalidationRules: spec.invalidationRules.map((rule) => ({
      type: rule.type,
      ...(rule.id ? { id: rule.id } : {}),
      ...(rule.side ? { side: rule.side } : {}),
      ...(typeof rule.level === 'number' ? { level: rule.level } : {}),
      ...(typeof rule.low === 'number' ? { low: rule.low } : {}),
      ...(typeof rule.high === 'number' ? { high: rule.high } : {}),
      ...(rule.timeframe ? { timeframe: rule.timeframe } : {}),
    })),
    managementRules: spec.managementRules.map((rule) => ({
      type: rule.type,
      ...(rule.id ? { id: rule.id } : {}),
      ...(typeof rule.multiple === 'number' ? { multiple: rule.multiple } : {}),
      ...(typeof rule.pct === 'number' ? { pct: rule.pct } : {}),
      ...(rule.op ? { op: rule.op } : {}),
    })),
    ...(spec.position ? {
      position: {
        side: spec.position.side,
        entry: spec.position.entry,
        ...(typeof spec.position.stop === 'number' ? { stop: spec.position.stop } : {}),
        ...(spec.position.targets ? { targets: [...spec.position.targets] } : {}),
        ...(typeof spec.position.size === 'number' ? { size: spec.position.size } : {}),
      },
    } : {}),
    ...(spec.expiry ? { expiry: spec.expiry } : {}),
  }
}

/**
 * Build one board item.
 *
 * `running` is the loop's own liveness: the caller passes the real poller
 * state, never an assumption, so a stopped loop renders as `poller stopped`
 * instead of a green dot.
 */
export function toBoardItem(input: {
  workspace: WorkspaceMeta
  issue: IssueRecord
  spec: WatchSpec
  state: WatchState
  running: boolean
  pollSeconds: number
  nowIso: string
}): WatcherBoardItem | null {
  const { workspace, issue, spec, state, nowIso } = input
  if (!isBoardVisible(issue)) return null
  return {
    watcherId: issue.id,
    workspaceId: workspace.id,
    workspaceLabel: workspace.tag,
    title: issue.title,
    running: input.running,
    pollable: !state.terminal,
    pollSeconds: input.pollSeconds,
    spec: toBoardSpec(spec),
    state: {
      armedAt: state.armedAt,
      lastChecked: state.lastChecked,
      lastPrice: state.lastPrice,
      lastMarketTimestamp: state.lastMarketTimestamp,
      lastConfirmedCandle: state.lastConfirmedCandle,
      previousConfirmedCandle: state.previousConfirmedCandle,
      terminal: state.terminal,
      pollCount: state.pollCount,
      errorCount: state.errorCount,
      lastError: state.lastError,
      backoffUntil: state.backoffUntil,
      firedConditions: { ...state.firedConditions },
    },
    // Stop/targets come from the frozen position the watcher evaluates against,
    // so the card cannot disagree with the rule that will actually fire.
    ...(spec.position ? {
      meta: {
        ...(typeof spec.position.stop === 'number' ? { stopLoss: spec.position.stop } : {}),
        ...(spec.position.targets ? { targets: [...spec.position.targets] } : {}),
      },
    } : {}),
    nowIso,
  }
}
