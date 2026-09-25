/**
 * Watcher board bridge — pushes the watch loop's live board to the Connector
 * Service, which renders it as a persistent card per watcher in the owner's
 * private chat.
 *
 * Fire-and-forget by design: the board is a LIVE VIEW of a local loop, not a
 * durable message. A Connector Service that is disabled, down, or slow simply
 * misses a frame and receives the next one — nothing is queued, retried, or
 * surfaced as an error to the watch loop. The loop's real work (evaluating
 * conditions) must never be coupled to a chat transport.
 */

import {
  ConnectorClient,
  type WatcherBoardItem,
  type WatcherBoardSync,
} from '@traderalice/connector-protocol'

import { readConnectorServiceEnabled } from '../../core/connector-config.js'
import { resolveConnectorUrl } from './index.js'

/** Board refresh cadence handed to the connector for its local pulse animation.
 *  The connector re-renders between Alice pushes; it does NOT call back. */
export const WATCHER_BOARD_REFRESH_SECONDS = 5

export interface WatcherBoardBridgeDeps {
  isEnabled(): Promise<boolean>
  push(board: WatcherBoardSync): Promise<void>
  warn(message: string): void
  refreshSeconds?: number
}

/**
 * Build the WatchLoop's `onBoard` callback.
 *
 * Returns a function that never rejects: the loop calls it inside its own
 * try/catch, but a board publisher that throws would still be a latent hazard
 * in a hot path, so it swallows everything and warns.
 */
export function createWatcherBoardPublisher(
  deps: WatcherBoardBridgeDeps,
): (items: WatcherBoardItem[]) => Promise<void> {
  const refreshSeconds = deps.refreshSeconds ?? WATCHER_BOARD_REFRESH_SECONDS
  return async (items) => {
    try {
      if (!await deps.isEnabled()) return
      await deps.push({ refreshSeconds, items })
    } catch (error) {
      deps.warn(error instanceof Error ? error.message : String(error))
    }
  }
}

/** Production wiring: the same loopback client the Inbox bridge uses. */
export function startWatcherBoardPublisher(): (
  items: WatcherBoardItem[],
) => Promise<void> {
  const client = new ConnectorClient(resolveConnectorUrl())
  return createWatcherBoardPublisher({
    isEnabled: readConnectorServiceEnabled,
    push: async (board) => {
      await client.syncWatcherBoard(board, AbortSignal.timeout(5_000))
    },
    warn: (message) => {
      console.warn('[connector] Watcher board publish unavailable:', message)
    },
  })
}
