/**
 * Watch loop — the market-condition evaluator.
 *
 * Deliberately SEPARATE from `ScheduleScanner`. The scanner answers "is any
 * Issue due by the clock?"; this loop answers "has any market condition become
 * true?". They share the dispatch primitive but nothing else, so a slow quote
 * fetch can never delay a scheduled fire and vice versa.
 *
 * Cost discipline (the whole point of this design): the hot path is ONE market
 * fetch per distinct pair per tick, plus pure arithmetic. No agent process is
 * created while a condition is false. A watcher that never fires costs a price
 * lookup every few seconds and nothing more.
 *
 * Ported from the Vibe-Trading watcher service (`agent/src/watcher/service.py`).
 */

import { join } from 'node:path'

import { ISSUES_DIR_REL, hasWatch, readWorkspaceIssues, type IssueRecord } from '../issues/declaration.js'
import type { Logger } from '../logger.js'
import type { WorkspaceMeta, WorkspaceRegistry } from '../workspace-registry.js'

import { toBoardItem } from './board.js'
import { evaluateWatch, initialState } from './evaluator.js'
import { readWatchRecord, writeWatchRecord } from './store.js'
import type { WatchEvent, WatchSnapshot, WatchSpec, WatchState } from './types.js'
import type { WatcherBoardItem } from '@traderalice/connector-protocol'

/** Production cadence. Every watcher is evaluated on this tick.
 *
 *  5s is the operator-facing default: fast enough that a level touch is caught
 *  near-live instead of up to half a minute late. The EFFECTIVE cadence can be
 *  slower \u2014 the loop has a re-entrancy guard, so a fetch that outlives the
 *  interval (see DEFAULT_FETCH_TIMEOUT_MS, deliberately 20s for slow vendor
 *  feeds) delays the next pass rather than stacking one. The board reports the
 *  CONFIGURED interval, which is what the operator asked for. */
export const DEFAULT_WATCH_INTERVAL_MS = 5_000

/** Per-fetch ceiling. A hung provider must not stall the whole tick.
 *
 *  Deliberately generous: the delayed vendor feeds (yfinance forex in
 *  particular) can legitimately take many seconds, and a too-tight ceiling makes
 *  a healthy watcher look permanently broken. The loop has a re-entrancy guard,
 *  so a long fetch delays the next pass rather than stacking one. */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000

/** Backoff bounds for a repeatedly failing market fetch. The first failure
 *  waits BASE, then doubles per consecutive failure up to MAX. Without this a
 *  chronically broken feed is re-fetched every tick forever, which is noisy and
 *  needlessly hammers a struggling provider. */
export const DEFAULT_BACKOFF_BASE_MS = 60_000
export const DEFAULT_BACKOFF_MAX_MS = 30 * 60_000

/** Consecutive failures before the backoff starts doubling. The first few
 *  failures retry at BASE so a one-off blip recovers on the next tick. */
const BACKOFF_FREE_FAILURES = 2

/** How many distinct pairs one tick may fetch before deferring the rest.
 *  Bounds a pathological workspace with hundreds of watchers. */
export const DEFAULT_MAX_FETCHES_PER_TICK = 50

/** Why a watcher fired, handed to the fire callback. */
export interface WatchFire {
  workspace: WorkspaceMeta
  issue: IssueRecord
  spec: WatchSpec
  events: WatchEvent[]
  snapshot: WatchSnapshot
  /** True when this pass reached a terminal state (invalidation/expiry). */
  terminal: boolean
}

/** Injected market access. Returns null when the pair cannot be priced. */
export type WatchSnapshotProvider = (spec: WatchSpec) => Promise<WatchSnapshot | null>

export interface WatchLoopDeps {
  registry: WorkspaceRegistry
  /** Fetch the live market facts for one watch. May throw; the loop isolates. */
  snapshot: WatchSnapshotProvider
  /** Wake the owning Session. Called ONCE per non-empty event batch. */
  onFire: (fire: WatchFire) => Promise<void>
  logger: Logger
  /**
   * Optional board projection. Called ONCE per tick with every watched Issue's
   * rendered card, so an external chat surface can keep a persistent, live view
   * of exactly what the loop is doing. Absent ⇒ no board is published and the
   * loop costs nothing extra.
   */
  onBoard?: (items: WatcherBoardItem[]) => Promise<void>
  /** Injectable clock for tests. */
  now?: () => number
  /** Injectable cadence for tests. */
  intervalMs?: number
  fetchTimeoutMs?: number
  maxFetchesPerTick?: number
}

/** Stable fingerprint of the authored spec. Changing it re-arms the watcher.
 *
 * `spec.meta` is deliberately EXCLUDED. Meta is presentation only, and a model
 * that updates a grade or phase after the fact must not reset fired-condition
 * history — that would clear the anti-spam guard and replay an alert for a
 * condition the operator already saw. */
export function specFingerprint(spec: WatchSpec): string {
  return JSON.stringify({
    pair: spec.pair,
    assetClass: spec.assetClass,
    direction: spec.direction,
    timeframe: spec.timeframe,
    rules: spec.rules,
    invalidationRules: spec.invalidationRules,
    managementRules: spec.managementRules,
    position: spec.position ?? null,
    expiry: spec.expiry ?? null,
  })
}

/** One watched Issue resolved from live disk state. */
export interface ResolvedWatch {
  workspace: WorkspaceMeta
  issue: IssueRecord
  spec: WatchSpec
}

/** Read every workspace and return the Issues that currently carry a watch. */
export async function collectWatches(registry: WorkspaceRegistry): Promise<ResolvedWatch[]> {
  const found: ResolvedWatch[] = []
  for (const workspace of registry.list()) {
    let result
    try {
      result = await readWorkspaceIssues(workspace.dir)
    } catch {
      continue
    }
    if (!result.ok) continue
    for (const issue of result.issues) {
      if (!hasWatch(issue)) continue
      found.push({ workspace, issue, spec: issue.watch })
    }
  }
  return found
}

/** Compute the next backoff deadline for a consecutive failure count. Returns
 *  null while the failure count is still within the free-retry window. */
export function nextBackoffMs(
  errorCount: number,
  baseMs: number = DEFAULT_BACKOFF_BASE_MS,
  maxMs: number = DEFAULT_BACKOFF_MAX_MS,
): number | null {
  if (errorCount <= BACKOFF_FREE_FAILURES) return null
  const steps = Math.min(errorCount - BACKOFF_FREE_FAILURES - 1, 20)
  return Math.min(baseMs * 2 ** steps, maxMs)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`watch snapshot timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

export class WatchLoop {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private ticking = false
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly fetchTimeoutMs: number
  private readonly maxFetchesPerTick: number

  constructor(private readonly deps: WatchLoopDeps) {
    this.now = deps.now ?? Date.now
    this.intervalMs = deps.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS
    this.fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    this.maxFetchesPerTick = deps.maxFetchesPerTick ?? DEFAULT_MAX_FETCHES_PER_TICK
  }

  /**
   * Effective cadence in whole seconds.
   *
   * Exposed so operator-facing copy (the Issue health message) describes the
   * interval this loop ACTUALLY runs at, instead of a number someone typed
   * once and forgot. A caller that cannot reach the loop simply omits it.
   */
  get intervalSeconds(): number {
    return this.intervalMs / 1000
  }

  /** Begin ticking. First pass happens after one interval, never on construct. */
  start(): void {
    if (this.timer || this.stopped) return
    this.arm()
    this.deps.logger.info('watch.loop_started', { intervalMs: this.intervalMs })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tickAndRearm(), this.intervalMs)
    this.timer.unref?.()
  }

  private async tickAndRearm(): Promise<void> {
    this.timer = null
    if (this.stopped) return
    try {
      await this.tick()
    } catch (err) {
      this.deps.logger.warn('watch.tick_failed', { err })
    }
    if (!this.stopped) this.arm()
  }

  /** One full pass. Public for tests and a future manual refresh. */
  async tick(): Promise<void> {
    // Re-entrancy guard: a slow provider must not stack concurrent passes.
    if (this.ticking) {
      this.deps.logger.info('watch.tick_overlap_skipped', {})
      return
    }
    this.ticking = true
    try {
      await this.runOnce()
    } finally {
      this.ticking = false
    }
  }

  private async runOnce(): Promise<void> {
    const nowIso = new Date(this.now()).toISOString()
    const watches = await collectWatches(this.deps.registry)
    if (watches.length === 0) {
      // Still publish an empty board: the last watcher may have been deleted or
      // marked done, and the external surface must clear its now-stale cards
      // instead of showing a watcher that no longer exists.
      if (this.deps.onBoard) {
        try {
          await this.deps.onBoard([])
        } catch (err) {
          this.deps.logger.warn('watch.board_publish_failed', { err })
        }
      }
      return
    }

    // One fetch per distinct pair/asset-class/timeframe, shared by every watch
    // that needs it. Five watchers on BTC cost one lookup, not five.
    const cache = new Map<string, Promise<WatchSnapshot | null>>()
    let fetches = 0

    const fetchKey = (spec: WatchSpec): string =>
      `${spec.assetClass}|${spec.pair}|${spec.timeframe}`

    const getSnapshot = (spec: WatchSpec): Promise<WatchSnapshot | null> => {
      const key = fetchKey(spec)
      const cached = cache.get(key)
      if (cached) return cached
      if (fetches >= this.maxFetchesPerTick) {
        return Promise.resolve(null)
      }
      fetches += 1
      const pending = withTimeout(this.deps.snapshot(spec), this.fetchTimeoutMs)
        .catch((err) => {
          this.deps.logger.warn('watch.snapshot_failed', { pair: spec.pair, err })
          return null
        })
      cache.set(key, pending)
      return pending
    }

    for (const watch of watches) {
      try {
        await this.evaluateOne(watch, getSnapshot, nowIso)
      } catch (err) {
        // One broken watcher must never stop the rest of the pass.
        this.deps.logger.warn('watch.evaluate_failed', {
          wsId: watch.workspace.id,
          issueId: watch.issue.id,
          err,
        })
      }
    }

    // Publish the board AFTER evaluating, so the card an operator sees carries
    // this tick's price and progress rather than the previous pass's. A board
    // failure is isolated: the evaluation above is the load-bearing work and
    // must not be rolled back by a chat transport outage.
    if (this.deps.onBoard) {
      try {
        await this.publishBoard(watches, nowIso)
      } catch (err) {
        this.deps.logger.warn('watch.board_publish_failed', { err })
      }
    }
  }

  /**
   * Build the external board from the state just persisted.
   *
   * Re-reads each sidecar instead of threading the in-memory result through:
   * the loop persists in several branches (fired, backed-off, skipped-terminal)
   * and the card must reflect what is actually on disk, not one branch's local
   * variable. A workspace whose Issue vanished mid-tick is simply dropped.
   */
  private async publishBoard(watches: ResolvedWatch[], nowIso: string): Promise<void> {
    const items: WatcherBoardItem[] = []
    for (const watch of watches) {
      const persisted = await readWatchRecord(watch.workspace.dir, watch.issue.id, nowIso)
      if (!persisted) continue
      const item = toBoardItem({
        workspace: watch.workspace,
        issue: watch.issue,
        spec: watch.spec,
        state: persisted.state,
        running: !this.stopped,
        pollSeconds: this.intervalMs / 1000,
        nowIso,
      })
      if (item) items.push(item)
    }
    await this.deps.onBoard?.(items)
  }

  private async evaluateOne(
    watch: ResolvedWatch,
    getSnapshot: (spec: WatchSpec) => Promise<WatchSnapshot | null>,
    nowIso: string,
  ): Promise<void> {
    const { workspace, issue, spec } = watch
    const persisted = await readWatchRecord(workspace.dir, issue.id, nowIso)

    // A rewritten `watch:` block is a NEW phase. Discard the previous phase's
    // firing history so its conditions cannot suppress the new rules, and so
    // the candle arming guard re-bases on the current time.
    const fingerprint = specFingerprint(spec)
    let state: WatchState
    if (!persisted || persisted.state.specFingerprint !== fingerprint) {
      state = { ...initialState(nowIso), specFingerprint: fingerprint }
      this.deps.logger.info('watch.armed', {
        wsId: workspace.id,
        issueId: issue.id,
        pair: spec.pair,
        rules: spec.rules.length,
        rearmed: Boolean(persisted),
      })
    } else {
      // A terminal watcher whose authored spec is unchanged is finished. Skip
      // it BEFORE fetching, so an invalidated or expired condition costs no
      // market data while it waits for the model to rewrite the Issue.
      if (persisted.state.terminal) return
      state = persisted.state
    }

    // A failing feed backs off. Skipping before the fetch keeps a dead provider
    // from being hammered every tick, and the deadline is persisted so a
    // restart cannot reset it into a retry storm.
    const backoffMs = Date.parse(state.backoffUntil ?? '')
    if (Number.isFinite(backoffMs) && backoffMs > this.now()) return

    const snapshot = await getSnapshot(spec)
    if (!snapshot) {
      // No price this tick. Do not touch state beyond the error bookkeeping so
      // a transient outage never looks like a fired condition.
      const errorCount = state.errorCount + 1
      const delay = nextBackoffMs(errorCount)
      await writeWatchRecord(workspace.dir, issue.id, {
        ...state,
        errorCount,
        lastError: 'market snapshot unavailable',
        lastChecked: nowIso,
        backoffUntil: delay === null ? null : new Date(this.now() + delay).toISOString(),
      }, persisted?.events ?? [])
      if (errorCount === 1 || errorCount % 10 === 0) {
        this.deps.logger.warn('watch.snapshot_unavailable', {
          wsId: workspace.id,
          issueId: issue.id,
          pair: spec.pair,
          errorCount,
          ...(delay === null ? {} : { backoffMs: delay }),
        })
      }
      return
    }

    const result = evaluateWatch(spec, state, snapshot, nowIso)
    const events: WatchEvent[] = result.events.map((event) => ({
      ...event,
      watcherId: issue.id,
    }))

    const nextState: WatchState = result.terminal
      ? { ...result.state, terminal: true }
      : result.state
    // A successful fetch clears the failure streak and any pending backoff, so a
    // recovered feed resumes normal cadence on the next tick.
    const healthy: WatchState = {
      ...nextState,
      errorCount: 0,
      lastError: null,
      backoffUntil: null,
    }
    const history = [...(persisted?.events ?? []), ...events]
    await writeWatchRecord(workspace.dir, issue.id, healthy, history)

    if (events.length === 0) return

    this.deps.logger.info('watch.fired', {
      wsId: workspace.id,
      issueId: issue.id,
      pair: spec.pair,
      events: events.map((event) => event.eventType),
      price: snapshot.price,
      terminal: result.terminal,
    })

    try {
      await this.deps.onFire({
        workspace,
        issue,
        spec,
        events,
        snapshot,
        terminal: result.terminal,
      })
    } catch (err) {
      // The fire callback owns its own retry story. Record and move on so one
      // failed wake cannot block every other watcher in the tick.
      this.deps.logger.warn('watch.fire_failed', {
        wsId: workspace.id,
        issueId: issue.id,
        err,
      })
    }
  }
}

/** Path helper kept beside the loop so callers never re-derive it. */
export function watchSidecarDir(wsDir: string): string {
  return join(wsDir, ISSUES_DIR_REL)
}
