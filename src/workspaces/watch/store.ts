/**
 * Watcher state persistence.
 *
 * State lives in a JSON sidecar beside the Issue that owns it:
 *
 *   <wsDir>/.alice/issues/<id>.watch.json
 *
 * Deliberately NOT part of the Issue markdown: the Issue is authored and
 * rewritten by the model, and runtime bookkeeping must not be clobbered by an
 * authoring edit. This mirrors the existing `.comments.json` sidecar pattern.
 *
 * Writes are atomic (tmp + rename) under a per-file lock so a crash mid-write
 * cannot corrupt the record and produce a duplicate fire on restart.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ISSUES_DIR_REL } from '../issues/declaration.js'
import { emptyWatchState, type WatchEvent, type WatchState } from './types.js'

/** Sidecar suffix appended to the Issue id. */
export const WATCH_SIDECAR_SUFFIX = '.watch.json'

interface WatchRecord {
  version: 1
  watcherId: string
  state: WatchState
  events: WatchEvent[]
}

/** Cap the retained event log so a long-lived watcher cannot grow unbounded. */
const MAX_EVENTS = 200

function sidecarPath(wsDir: string, issueId: string): string {
  return join(wsDir, ISSUES_DIR_REL, `${issueId}${WATCH_SIDECAR_SUFFIX}`)
}

/** Decode a persisted state blob, tolerating a partial or legacy record. */
function decodeState(value: unknown, fallbackArmedAt: string): WatchState {
  const base = emptyWatchState(fallbackArmedAt)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base
  const raw = value as Record<string, unknown>
  const str = (key: string): string | null => (typeof raw[key] === 'string' ? (raw[key] as string) : null)
  const num = (key: string): number | null => (typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : null)
  const record = (key: string): Record<string, string> => {
    const v = raw[key]
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string') out[k] = val
    }
    return out
  }
  const candle = (key: string): WatchState['lastConfirmedCandle'] => {
    const v = raw[key]
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const c = v as Record<string, unknown>
    if (typeof c.close !== 'number' || typeof c.timestamp !== 'string') return null
    return {
      timestamp: c.timestamp,
      open: typeof c.open === 'number' ? c.open : c.close,
      high: typeof c.high === 'number' ? c.high : c.close,
      low: typeof c.low === 'number' ? c.low : c.close,
      close: c.close,
      ...(typeof c.volume === 'number' ? { volume: c.volume } : {}),
      ...(typeof c.timeframe === 'string' ? { timeframe: c.timeframe } : {}),
      ...(c.confirmed === false ? { confirmed: false } : {}),
    }
  }
  const priceSource = (key: string): WatchState['lastPriceSource'] => {
    const v = raw[key]
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const s = v as Record<string, unknown>
    const kind = s['kind']
    if (kind !== 'tv-feed' && kind !== 'vendor') return null
    if (typeof s['ref'] !== 'string') return null
    return {
      kind,
      ref: s['ref'],
      ...(s['fellBack'] === true ? { fellBack: true } : {}),
    }
  }
  return {
    armedAt: str('armedAt') ?? fallbackArmedAt,
    specFingerprint: str('specFingerprint'),
    lastChecked: str('lastChecked'),
    lastPrice: num('lastPrice'),
    lastMarketTimestamp: str('lastMarketTimestamp'),
    lastPriceSource: priceSource('lastPriceSource'),
    lastConfirmedCandle: candle('lastConfirmedCandle'),
    previousConfirmedCandle: candle('previousConfirmedCandle'),
    lastEvent: str('lastEvent'),
    terminal: raw['terminal'] === true,
    alertedConditions: record('alertedConditions'),
    firedConditions: record('firedConditions'),
    cooldownUntil: str('cooldownUntil'),
    backoffUntil: str('backoffUntil'),
    pollCount: num('pollCount') ?? 0,
    errorCount: num('errorCount') ?? 0,
    lastError: str('lastError'),
  }
}

function decodeEvents(value: unknown): WatchEvent[] {
  if (!Array.isArray(value)) return []
  const out: WatchEvent[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.eventType !== 'string' || typeof raw.at !== 'string') continue
    out.push({
      watcherId: typeof raw.watcherId === 'string' ? raw.watcherId : '',
      eventType: raw.eventType as WatchEvent['eventType'],
      conditionKey: typeof raw.conditionKey === 'string' ? raw.conditionKey : '',
      message: typeof raw.message === 'string' ? raw.message : '',
      price: typeof raw.price === 'number' && Number.isFinite(raw.price) ? raw.price : null,
      at: raw.at,
      ...(raw.data && typeof raw.data === 'object' ? { data: raw.data as Record<string, unknown> } : {}),
    })
  }
  return out.slice(-MAX_EVENTS)
}

/** Read the persisted record for one Issue, or null when none exists yet. */
export async function readWatchRecord(
  wsDir: string,
  issueId: string,
  nowIso: string,
): Promise<{ state: WatchState; events: WatchEvent[] } | null> {
  try {
    const raw = await readFile(sidecarPath(wsDir, issueId), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      state: decodeState(parsed.state, nowIso),
      events: decodeEvents(parsed.events),
    }
  } catch {
    return null
  }
}

/** Persist the record for one Issue. Atomic: tmp write then rename. */
export async function writeWatchRecord(
  wsDir: string,
  issueId: string,
  state: WatchState,
  events: WatchEvent[],
): Promise<void> {
  const dir = join(wsDir, ISSUES_DIR_REL)
  const target = sidecarPath(wsDir, issueId)
  const payload: WatchRecord = {
    version: 1,
    watcherId: issueId,
    state,
    events: events.slice(-MAX_EVENTS),
  }
  await mkdir(dir, { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
  await rename(tmp, target)
}

/** Delete a watcher's record (terminal cleanup). Missing is success. */
export async function deleteWatchRecord(wsDir: string, issueId: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(sidecarPath(wsDir, issueId), { force: true })
}

/** Every Issue id in a workspace that currently has a persisted watch record.
 *  Used to detect orphans whose Issue was removed or lost its `watch:`. */
export async function listWatchRecordIds(wsDir: string): Promise<string[]> {
  const dir = join(wsDir, ISSUES_DIR_REL)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith(WATCH_SIDECAR_SUFFIX))
    .map((name) => name.slice(0, -WATCH_SIDECAR_SUFFIX.length))
    .sort()
}
