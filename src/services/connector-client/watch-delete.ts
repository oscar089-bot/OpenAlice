/**
 * Connector → Alice watcher deletion.
 *
 * A chat surface owns the Delete button but NOT the watch state. Alice owns the
 * watch store, and the board is a view of it, so a delete round-trips: the
 * connector queues the intent, this drains it, and Alice performs the removal.
 * That keeps the watch store single-writer — a card can never disagree with the
 * loop about what is armed.
 *
 * Mirrors `uta-review.ts`: claim, fulfil, ack or release. A release (not an ack)
 * leaves the request queued for a later tick, so a transient filesystem error is
 * retried rather than silently dropping the operator's intent.
 */

import {
  isConnectorActionExpired,
  type ConnectorWatchRequest,
} from '@traderalice/connector-protocol'

import { updateIssueFields } from '../../workspaces/issues/mutate.js'

export interface ConnectorWatchBridgeDeps {
  isEnabled(): Promise<boolean>
  claimWatchActions?(): Promise<{ claimId: string; items: ConnectorWatchRequest[] }>
  ackWatchActions?: (claimId: string, itemIds: string[]) => Promise<void>
  releaseWatchActions?: (claimId: string, itemIds: string[]) => Promise<void>
  /** Resolve a workspace id to its on-disk directory. */
  resolveWorkspace(id: string): { dir: string } | null
  /**
   * Perform the removal. Injectable so the bridge can be tested without
   * touching the filesystem, and so production wiring stays explicit about the
   * fact that this is the SAME mutator the Settings UI uses.
   */
  deleteWatch?(wsDir: string, watcherId: string): Promise<{ ok: boolean; reason?: string }>
  warn(message: string): void
  now?: () => number
}

export async function processConnectorWatchRequests(
  deps: ConnectorWatchBridgeDeps,
): Promise<void> {
  if (!await deps.isEnabled()) return
  const claim = deps.claimWatchActions ? await deps.claimWatchActions() : null
  if (!claim) return
  const now = deps.now?.() ?? Date.now()
  const completed: string[] = []
  const retry: string[] = []
  for (const request of claim.items) {
    if (await fulfillWatchRequest(deps, request, now)) completed.push(request.requestId)
    else retry.push(request.requestId)
  }
  if (completed.length > 0) await deps.ackWatchActions?.(claim.claimId, completed)
  if (retry.length > 0) await deps.releaseWatchActions?.(claim.claimId, retry)
}

/**
 * Apply one requested action. `true` means "settled" — success OR a permanent
 * refusal. `false` means "try again", which is what a missing workspace is.
 */
async function fulfillWatchRequest(
  deps: ConnectorWatchBridgeDeps,
  request: ConnectorWatchRequest,
  now: number,
): Promise<boolean> {
  if (isConnectorActionExpired(request.createdAt, now)) {
    deps.warn(`Watcher request ${request.requestId} expired before it was applied.`)
    return true
  }
  const workspace = deps.resolveWorkspace(request.workspaceId)
  if (!workspace) {
    // A workspace that is temporarily absent (mid-rename, on a remote that is
    // still syncing) must not consume the request. Release and retry.
    deps.warn(`Watcher request ${request.requestId}: workspace ${request.workspaceId} is unavailable.`)
    return false
  }
  if (request.action !== 'delete') {
    deps.warn(`Watcher request ${request.requestId}: unsupported action ${String(request.action)}.`)
    return true
  }
  // `watch: null` removes both the frontmatter block and its persisted state
  // sidecar, so this is the same operation the Settings UI performs — there is
  // no second deletion path that could leave an orphaned record.
  const remove = deps.deleteWatch ?? defaultDeleteWatch
  const result = await remove(workspace.dir, request.watcherId)
  if (result.ok) return true
  if (result.reason === 'not_found') {
    // Already gone (deleted in another surface, or the Issue was removed).
    // That is the desired end state, so settle rather than retry forever.
    return true
  }
  deps.warn(`Watcher request ${request.requestId} failed: ${result.reason ?? 'unknown'}`)
  return false
}

/** Production deletion: the same issue mutator the Settings UI calls. */
async function defaultDeleteWatch(wsDir: string, watcherId: string): Promise<{ ok: boolean; reason?: string }> {
  const result = await updateIssueFields(wsDir, watcherId, { watch: null })
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}
