/**
 * Durable retry queue for deliveries that failed for a TRANSIENT reason.
 *
 * The Connector Service already records every attempt in the I/O journal, but a
 * recorded failure is still a LOST message: a send that arrives while the bot
 * session is not ready (the normal state for the first seconds after a restart)
 * was simply abandoned, and the operator never learned the watcher had fired.
 *
 * This store keeps the small set of deliveries worth retrying so they survive a
 * restart and eventually land. Two properties keep it honest:
 *
 * - It is BOUNDED. A permanently broken transport must not grow this file
 *   without limit, so entries are capped and aged out.
 * - It is SEALED and adapter-owned. Delivery bookkeeping is transport state, not
 *   operator configuration, so it never appears in the Settings UI.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { dataPath } from '@/core/paths.js'
import { isSealedEnvelope, seal, unseal } from '@/core/sealing.js'

/** Hard cap on queued retries. Oldest are dropped first: a flood of stale
 *  alerts is worse than losing the tail of one, and the cap is what stops a
 *  permanently unreachable transport from growing this file forever. */
export const MAX_PENDING_DELIVERIES = 50

/** Give up on an entry this long after its first failure. A restart window is
 *  seconds to minutes, not days; an alert delivered tomorrow reads as noise. */
export const PENDING_DELIVERY_TTL_MS = 6 * 60 * 60 * 1000

/** Attempts before the entry is dropped and marked exhausted. */
export const MAX_DELIVERY_ATTEMPTS = 6

const entrySchema = z.object({
  /** Stable delivery key, so re-scheduling the same message cannot duplicate. */
  key: z.string().min(1).max(200),
  connectorId: z.string().min(1).max(64),
  /** What to re-send. Opaque here; the DeliveryManager owns the shape. */
  kind: z.enum(['notification', 'owner-chat']),
  payload: z.unknown(),
  attempts: z.number().int().min(0),
  /** Epoch ms of the first failure, for TTL ageing. */
  firstFailedAt: z.number().int().nonnegative(),
  /** Epoch ms when the next attempt is due. */
  nextAttemptAt: z.number().int().nonnegative(),
  /** Last error, kept for the journal and for operator diagnosis. */
  lastError: z.string().max(500).optional(),
})

export type PendingDeliveryEntry = z.infer<typeof entrySchema>

const stateSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
})

export function pendingDeliveryPath(): string {
  return dataPath('state', 'connector-pending-deliveries.json')
}

/** Read queued retries. Missing or malformed => empty, never a throw: a corrupt
 *  retry file must not stop the Connector Service from starting. */
export async function loadPendingDeliveries(
  path: string = pendingDeliveryPath(),
  now: number = Date.now(),
): Promise<PendingDeliveryEntry[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isSealedEnvelope(raw)) return []
    const state = stateSchema.parse(await unseal(raw))
    // Drop anything already past its TTL on read, so a long downtime cannot
    // resurrect stale alerts the moment the service comes back.
    return state.entries
      .filter((entry) => now - entry.firstFailedAt < PENDING_DELIVERY_TTL_MS)
      .slice(-MAX_PENDING_DELIVERIES)
  } catch {
    return []
  }
}

/** Persist atomically, applying the cap so the file cannot grow unbounded. */
export async function savePendingDeliveries(
  entries: readonly PendingDeliveryEntry[],
  path: string = pendingDeliveryPath(),
): Promise<void> {
  const payload = {
    version: 1 as const,
    entries: [...entries].slice(-MAX_PENDING_DELIVERIES),
  }
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(await seal(payload), null, 2)}\n`, { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/** Backoff for attempt N: 5s, 10s, 20s, 40s, 80s, 160s. */
export function retryDelayMs(attempts: number): number {
  const step = Math.max(0, Math.min(attempts, 6))
  return Math.min(5_000 * 2 ** step, 160_000)
}
