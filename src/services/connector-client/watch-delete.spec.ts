import { describe, expect, it, vi } from 'vitest'

import { processConnectorWatchRequests } from './watch-delete.js'

function deps(overrides: Record<string, unknown> = {}) {
  const ackWatchActions = vi.fn(async () => undefined)
  const releaseWatchActions = vi.fn(async () => undefined)
  const warn = vi.fn()
  const deleteWatch = vi.fn(async () => ({ ok: true }))
  return {
    ackWatchActions,
    releaseWatchActions,
    warn,
    deleteWatch,
    base: {
      isEnabled: async () => true,
      claimWatchActions: async () => ({
        claimId: 'c1',
        items: [{
          requestId: 'watch-1',
          connectorId: 'discord',
          createdAt: new Date(1_000).toISOString(),
          action: 'delete' as const,
          workspaceId: 'ws-a',
          watcherId: 'sol-pullback-watch',
        }],
      }),
      ackWatchActions,
      releaseWatchActions,
      resolveWorkspace: () => ({ dir: '/tmp/ws-a' }),
      deleteWatch,
      warn,
      now: () => 2_000,
      ...overrides,
    },
  }
}

describe('connector watch deletion', () => {
  it('removes the watch and acks the request', async () => {
    const { base, ackWatchActions, releaseWatchActions, deleteWatch } = deps()
    await processConnectorWatchRequests(base as never)
    expect(deleteWatch).toHaveBeenCalledWith('/tmp/ws-a', 'sol-pullback-watch')
    expect(ackWatchActions).toHaveBeenCalledWith('c1', ['watch-1'])
    expect(releaseWatchActions).not.toHaveBeenCalled()
  })

  // A workspace that is momentarily absent must NOT consume the request, or a
  // button press during a rename would silently drop the operator's intent.
  it('releases rather than acks when the workspace is unavailable', async () => {
    const { base, ackWatchActions, releaseWatchActions, warn } = deps({
      resolveWorkspace: () => null,
    })
    await processConnectorWatchRequests(base as never)
    expect(releaseWatchActions).toHaveBeenCalledWith('c1', ['watch-1'])
    expect(ackWatchActions).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('does nothing when the connector service is disabled', async () => {
    const { base, ackWatchActions, deleteWatch } = deps({ isEnabled: async () => false })
    await processConnectorWatchRequests(base as never)
    expect(ackWatchActions).not.toHaveBeenCalled()
    expect(deleteWatch).not.toHaveBeenCalled()
  })

  // An expired request must settle, not retry forever.
  it('settles an expired request instead of retrying it', async () => {
    const { base, ackWatchActions, releaseWatchActions, deleteWatch } = deps({ now: () => 10 * 60_000 })
    await processConnectorWatchRequests(base as never)
    expect(deleteWatch).not.toHaveBeenCalled()
    expect(ackWatchActions).toHaveBeenCalledWith('c1', ['watch-1'])
    expect(releaseWatchActions).not.toHaveBeenCalled()
  })

  // Already-gone is the desired end state, so it settles instead of looping.
  it('settles when the watch is already deleted', async () => {
    const { base, ackWatchActions, releaseWatchActions } = deps({
      deleteWatch: async () => ({ ok: false, reason: 'not_found' }),
    })
    await processConnectorWatchRequests(base as never)
    expect(ackWatchActions).toHaveBeenCalledWith('c1', ['watch-1'])
    expect(releaseWatchActions).not.toHaveBeenCalled()
  })

  // A real failure keeps the intent queued rather than dropping it.
  it('releases when the removal genuinely fails', async () => {
    const { base, ackWatchActions, releaseWatchActions, warn } = deps({
      deleteWatch: async () => ({ ok: false, reason: 'invalid' }),
    })
    await processConnectorWatchRequests(base as never)
    expect(releaseWatchActions).toHaveBeenCalledWith('c1', ['watch-1'])
    expect(ackWatchActions).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})
