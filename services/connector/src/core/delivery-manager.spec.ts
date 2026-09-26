import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConnectorAdapterConfig,
  ConnectorAdapterHealth,
  InboxNotification,
} from '@traderalice/connector-protocol'
import type { ConnectorAdapter, ConnectorAdapterContext } from './adapter.js'
import { ConnectorRegistry } from './adapter.js'
import {
  DeliveryManager,
  MAX_INBOUND_OWNER_MESSAGES,
} from './delivery-manager.js'
import { createConnectorIOEvent, type ConnectorIOEvent, type ConnectorIORecorder } from './io-events.js'
import type { ConnectorWorkKind, ConnectorWorkQueueStore } from './work-queue.js'

class MemoryWorkQueue implements ConnectorWorkQueueStore {
  private entries: Array<{ id: string; kind: ConnectorWorkKind; payload: unknown; claimId?: string }> = []
  async enqueue<T>(kind: ConnectorWorkKind, id: string, payload: T): Promise<void> {
    const limit = kind === 'inbound' ? 100 : 20
    if (this.entries.filter((entry) => entry.kind === kind).length >= limit) throw new Error(`Connector ${kind} queue is full. Try again.`)
    this.entries.push({ id, kind, payload })
  }
  async claim<T>(kind: ConnectorWorkKind, limit: number) {
    const claimId = `claim-${kind}`
    const selected = this.entries.filter((entry) => entry.kind === kind && !entry.claimId).slice(0, limit)
    selected.forEach((entry) => { entry.claimId = claimId })
    return { claimId, items: selected.map((entry) => ({ id: entry.id, payload: entry.payload as T })) }
  }
  async ack(claimId: string, itemIds: readonly string[]): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.claimId !== claimId || !itemIds.includes(entry.id))
  }
  async release(claimId: string, itemIds: readonly string[]): Promise<void> {
    this.entries.forEach((entry) => {
      if (entry.claimId === claimId && itemIds.includes(entry.id)) delete entry.claimId
    })
  }
}

async function drainInbound(manager: DeliveryManager) {
  const claim = await manager.claimInbound()
  await manager.ackInbound(claim.claimId, claim.items.map((item) => item.id))
  return claim.items.map((item) => item.payload)
}

async function drainActions(manager: DeliveryManager) {
  const claim = await manager.claimActions()
  await manager.ackActions(claim.claimId, claim.items.map((item) => item.id))
  return claim.items.map((item) => item.payload)
}

async function drainUtaActions(manager: DeliveryManager) {
  const claim = await manager.claimUtaActions()
  await manager.ackActions(claim.claimId, claim.items.map((item) => item.id))
  return claim.items.map((item) => item.payload)
}

class MemoryRecorder implements ConnectorIORecorder {
  readonly events: ConnectorIOEvent[] = []
  async record(input: Parameters<ConnectorIORecorder['record']>[0]): Promise<void> {
    this.events.push(createConnectorIOEvent(input))
  }
}

class FakeThirdPartyAdapter implements ConnectorAdapter {
  readonly id = 'carrier-pigeon'
  readonly delivered: InboxNotification[] = []
  private status: ConnectorAdapterHealth['status'] = 'stopped'

  async start(_config: ConnectorAdapterConfig, _context: ConnectorAdapterContext): Promise<void> {
    this.status = 'healthy'
  }

  async stop(): Promise<void> {
    this.status = 'stopped'
  }

  async deliver(notification: InboxNotification): Promise<void> {
    this.delivered.push(notification)
  }

  async sendOwnerText(_text: string): Promise<void> {}

  health(): ConnectorAdapterHealth {
    return { id: this.id, enabled: true, status: this.status }
  }
}

describe('DeliveryManager connector registry', () => {
  it('runs an unrecognized third adapter without changing delivery core', async () => {
    const adapter = new FakeThirdPartyAdapter()
    const registry = new ConnectorRegistry()
    registry.register({
      definition: {
        id: 'carrier-pigeon',
        label: 'Carrier Pigeon',
        description: 'Test-only third connector.',
        fields: [],
        commands: [],
      },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { 'carrier-pigeon': { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
      workQueue: new MemoryWorkQueue(),
    })

    await manager.start()
    await manager.deliver({
      id: 'inbox-1',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      title: 'Hello from Inbox',
      body: 'No Discord or Telegram branch was involved.',
    })

    expect(adapter.delivered).toHaveLength(1)
    expect(manager.health()).toMatchObject({ status: 'healthy' })
    await manager.acceptInbound({ connectorId: 'carrier-pigeon', userId: '1', text: 'hello' })
    expect(await drainInbound(manager)).toEqual([
      { connectorId: 'carrier-pigeon', userId: '1', text: 'hello' },
    ])
    expect(await drainInbound(manager)).toEqual([])
    await manager.acceptInbound({ connectorId: 'carrier-pigeon', userId: '1', text: '' })
    expect(await drainInbound(manager)).toEqual([])
    for (let i = 0; i < MAX_INBOUND_OWNER_MESSAGES; i += 1) {
      await manager.acceptInbound({ connectorId: 'carrier-pigeon', userId: '1', text: `m${i}` })
    }
    await expect(manager.acceptInbound({ connectorId: 'carrier-pigeon', userId: '1', text: 'overflow' }))
      .rejects.toThrow('queue is full')
    const kept = await drainInbound(manager)
    expect(kept).toHaveLength(MAX_INBOUND_OWNER_MESSAGES)
    expect(kept[0]?.text).toBe('m0')
    expect(kept.at(-1)?.text).toBe(`m${MAX_INBOUND_OWNER_MESSAGES - 1}`)
    await manager.stop()
  })

  it('replaces only the requested adapter during an explicit reconnect', async () => {
    const created: FakeThirdPartyAdapter[] = []
    const registry = new ConnectorRegistry()
    registry.register({
      definition: {
        id: 'carrier-pigeon',
        label: 'Carrier Pigeon',
        description: 'Test-only third connector.',
        fields: [],
        commands: [],
      },
      create: () => {
        const adapter = new FakeThirdPartyAdapter()
        created.push(adapter)
        return adapter
      },
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { 'carrier-pigeon': { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
    })

    await manager.start()
    const health = await manager.reconnect('carrier-pigeon')

    expect(created).toHaveLength(2)
    expect(created[0]?.health().status).toBe('stopped')
    expect(health.status).toBe('healthy')
    await manager.stop()
  })

  it('reconciles one adapter without stopping or recreating its peers', async () => {
    const calls = new Map<string, { starts: ReturnType<typeof vi.fn>; stops: ReturnType<typeof vi.fn>; created: number }>()
    const registry = new ConnectorRegistry()
    for (const id of ['alpha', 'beta']) {
      const state = { starts: vi.fn(), stops: vi.fn(), created: 0 }
      calls.set(id, state)
      registry.register({
        definition: { id, label: id, description: `${id} adapter`, fields: [], commands: [] },
        create: () => {
          state.created += 1
          let status: ConnectorAdapterHealth['status'] = 'stopped'
          return {
            id,
            start: async () => { state.starts(); status = 'healthy' },
            stop: async () => { state.stops(); status = 'stopped' },
            deliver: async () => undefined,
            sendOwnerText: async () => undefined,
            health: () => ({ id, enabled: true, status }),
          }
        },
      })
    }
    const manager = new DeliveryManager({
      registry,
      config: {
        version: 1,
        adapters: {
          alpha: { enabled: true, settings: { inboxPush: true } },
          beta: { enabled: true, settings: { inboxPush: true } },
        },
      },
      updateAdapterSettings: vi.fn(),
    })

    await manager.start()
    expect(calls.get('alpha')).toMatchObject({ created: 1 })
    expect(calls.get('beta')).toMatchObject({ created: 1 })

    expect(await manager.reconcile('alpha', { enabled: false, settings: {} })).toEqual({
      id: 'alpha',
      enabled: false,
      status: 'disabled',
    })
    expect(calls.get('alpha')?.stops).toHaveBeenCalledOnce()
    expect(calls.get('beta')?.stops).not.toHaveBeenCalled()
    expect(calls.get('beta')).toMatchObject({ created: 1 })

    await manager.reconcile('alpha', { enabled: true, settings: { inboxPush: false } })
    expect(calls.get('alpha')).toMatchObject({ created: 2 })
    expect(calls.get('alpha')?.starts).toHaveBeenCalledTimes(2)
    expect(calls.get('beta')?.starts).toHaveBeenCalledOnce()
    expect(calls.get('beta')?.stops).not.toHaveBeenCalled()
    await manager.stop()
  })

  it('reports starting adapters before external startup finishes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const adapter: ConnectorAdapter = {
      id: 'slow',
      start: async () => { await gate },
      stop: async () => undefined,
      deliver: async () => undefined,
      sendOwnerText: async () => undefined,
      health: () => ({ id: 'slow', enabled: true, status: 'starting' }),
    }
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'slow', label: 'Slow', description: 'Slow adapter.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { slow: { enabled: true, settings: {} } } },
      updateAdapterSettings: async () => undefined,
    })

    manager.installEnabledAdapters()
    expect(manager.health()).toMatchObject({
      status: 'healthy',
      adapters: [{ id: 'slow', status: 'starting' }],
    })

    const started = manager.start()
    release()
    await started
    await manager.stop()
  })

  it('keeps a failed adapter registered so its degraded health remains visible', async () => {
    const adapter: ConnectorAdapter = {
      id: 'broken',
      start: async () => { throw new Error('Telegram API did not become ready') },
      stop: async () => undefined,
      deliver: async () => { throw new Error('Telegram is not ready') },
      sendOwnerText: async () => undefined,
      health: () => ({
        id: 'broken',
        enabled: true,
        status: 'degraded',
        lastError: 'Telegram API did not become ready',
      }),
    }
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'broken', label: 'Broken', description: 'Broken adapter.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { broken: { enabled: true, settings: {} } } },
      updateAdapterSettings: async () => undefined,
      adapterStartRetryDelayMs: 60_000,
    })

    await manager.start()

    expect(manager.health()).toMatchObject({
      status: 'degraded',
      adapters: [{ id: 'broken', status: 'degraded', lastError: 'Telegram API did not become ready' }],
    })
    await manager.stop()
  })

  it('retries a transient adapter start failure without dropping the registration', async () => {
    let attempts = 0
    let status: ConnectorAdapterHealth['status'] = 'degraded'
    const adapter: ConnectorAdapter = {
      id: 'flaky',
      classifyStartFailure: () => 'retry',
      start: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('Telegram polling did not become ready within 15000ms')
        status = 'healthy'
      },
      stop: async () => { status = 'stopped' },
      deliver: async () => undefined,
      sendOwnerText: async () => undefined,
      health: () => ({ id: 'flaky', enabled: true, status }),
    }
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'flaky', label: 'Flaky', description: 'Flaky adapter.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { flaky: { enabled: true, settings: {} } } },
      updateAdapterSettings: async () => undefined,
      adapterStartRetryDelayMs: 5,
    })

    await manager.start()
    expect(attempts).toBe(1)
    expect(manager.health().adapters[0]?.status).toBe('degraded')

    await vi.waitFor(() => {
      expect(attempts).toBe(2)
      expect(manager.health().adapters[0]?.status).toBe('healthy')
    })
    await manager.stop()
  })

  it('does not retry a configuration error', async () => {
    let attempts = 0
    const adapter: ConnectorAdapter = {
      id: 'invalid',
      start: async () => {
        attempts += 1
        throw new Error('Telegram setting botToken is required')
      },
      stop: async () => undefined,
      deliver: async () => undefined,
      sendOwnerText: async () => undefined,
      health: () => ({
        id: 'invalid',
        enabled: true,
        status: 'degraded',
        lastError: 'Telegram setting botToken is required',
      }),
    }
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'invalid', label: 'Invalid', description: 'Invalid adapter.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { invalid: { enabled: true, settings: {} } } },
      updateAdapterSettings: async () => undefined,
      adapterStartRetryDelayMs: 5,
    })

    await manager.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(1)
    await manager.stop()
  })

  it('cancels a pending start retry on stop', async () => {
    let attempts = 0
    const adapter: ConnectorAdapter = {
      id: 'slow-fail',
      classifyStartFailure: () => 'retry',
      start: async () => {
        attempts += 1
        throw new Error('Network request for \'getMe\' failed!')
      },
      stop: async () => undefined,
      deliver: async () => undefined,
      sendOwnerText: async () => undefined,
      health: () => ({ id: 'slow-fail', enabled: true, status: 'degraded' }),
    }
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'slow-fail', label: 'Slow fail', description: 'Fails.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { 'slow-fail': { enabled: true, settings: {} } } },
      updateAdapterSettings: async () => undefined,
      adapterStartRetryDelayMs: 50,
    })

    await manager.start()
    expect(attempts).toBe(1)
    await manager.stop()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(attempts).toBe(1)
  })

  it('contains adapter delivery failures', async () => {
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'broken', label: 'Broken', description: 'Broken adapter.', fields: [], commands: [] },
      create: () => ({
        id: 'broken',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async () => { throw new Error('external outage') },
        sendOwnerText: async () => undefined,
        health: () => ({ id: 'broken', enabled: true, status: 'degraded' as const, lastError: 'external outage' }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { broken: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()

    await expect(manager.deliver({
      id: 'inbox-2',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      title: 'Still durable',
      body: '',
    })).resolves.toBeUndefined()
  })

  it('skips Inbox push when the adapter turned it off', async () => {
    const deliver = vi.fn(async () => undefined)
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'quiet', label: 'Quiet', description: 'Quiet adapter.', fields: [], commands: [] },
      create: () => ({
        id: 'quiet',
        start: async () => undefined,
        stop: async () => undefined,
        deliver,
        sendOwnerText: async () => undefined,
        health: () => ({ id: 'quiet', enabled: true, status: 'healthy' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { quiet: { enabled: true, settings: { inboxPush: false } } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()
    await manager.deliver({
      id: 'inbox-3',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      title: 'Stay local',
      body: '',
    })
    expect(deliver).not.toHaveBeenCalled()
    await manager.stop()
  })

  it('delivers only to adapters named by the notification allow-list', async () => {
    const create = (id: string) => {
      const deliver = vi.fn(async () => undefined)
      return { id, deliver }
    }
    const alpha = create('alpha')
    const discord = create('discord')
    const registry = new ConnectorRegistry()
    for (const adapter of [alpha, discord]) {
      registry.register({
        definition: { id: adapter.id, label: adapter.id, description: `${adapter.id} adapter.`, fields: [], commands: [] },
        create: () => ({
          id: adapter.id,
          start: async () => undefined,
          stop: async () => undefined,
          deliver: adapter.deliver,
          sendOwnerText: async () => undefined,
          health: () => ({ id: adapter.id, enabled: true, status: 'healthy' as const }),
        }),
      })
    }
    const manager = new DeliveryManager({
      registry,
      config: {
        version: 1,
        adapters: {
          alpha: { enabled: true, settings: { inboxPush: true } },
          discord: { enabled: true, settings: { inboxPush: true } },
        },
      },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()

    // A watcher alert targets Discord only; a private chat must not receive it.
    await manager.deliver({
      id: 'inbox-watch',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      title: 'Watcher fired',
      body: '',
      deliverTo: ['discord'],
    })

    expect(discord.deliver).toHaveBeenCalledOnce()
    expect(alpha.deliver).not.toHaveBeenCalled()
    await manager.stop()
  })

describe('DeliveryManager retry of transient failures', () => {
  it('re-delivers a notification that failed while the transport was not ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delivery-retry-'))
    const path = join(dir, 'pending.json')
    const delivered: InboxNotification[] = []
    let ready = false
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'telegram', label: 'Telegram', description: 'Telegram.', fields: [], commands: [] },
      create: () => ({
        id: 'telegram',
        start: async () => undefined,
        stop: async () => undefined,
        // The restart case: the send is refused until the session is up.
        deliver: async (notification) => {
          if (!ready) throw new Error('Telegram bot is not ready')
          delivered.push(notification)
        },
        sendOwnerText: async () => undefined,
        health: () => ({ id: 'telegram', enabled: true, status: 'healthy' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { telegram: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
      pendingDeliveryPath: path,
    })
    try {
      await manager.start()
      const notification: InboxNotification = {
        id: 'alert-1',
        createdAt: new Date().toISOString(),
        workspaceId: 'ws-1',
        title: 'Inbox update from chat',
        body: '**Watcher fired** — BTC reclaim watch',
        deliverTo: ['telegram'],
      }
      // A retryable refusal is ACCEPTED, not rethrown: the service now owns it.
      await expect(manager.deliver(notification)).resolves.toBeUndefined()
      expect(delivered).toHaveLength(0)

      // Transport comes up, and the queued alert lands on a later tick.
      ready = true
      await manager.retryPending(Date.now() + 60_000)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.id).toBe('alert-1')
      // Drained, so a further tick does not send it twice.
      await manager.retryPending(Date.now() + 120_000)
      expect(delivered).toHaveLength(1)
    } finally {
      await manager.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not retry a permanent failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delivery-retry-'))
    const path = join(dir, 'pending.json')
    const registry = new ConnectorRegistry()
    const deliver = vi.fn(async () => { throw new Error('malformed payload rejected') })
    registry.register({
      definition: { id: 'telegram', label: 'Telegram', description: 'Telegram.', fields: [], commands: [] },
      create: () => ({
        id: 'telegram',
        start: async () => undefined,
        stop: async () => undefined,
        deliver,
        sendOwnerText: async () => undefined,
        health: () => ({ id: 'telegram', enabled: true, status: 'healthy' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { telegram: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
      pendingDeliveryPath: path,
    })
    try {
      await manager.start()
      // `deliver` settles through `allSettled`, so a failure never reaches the
      // caller — it is visible in the IO journal. What matters here is that a
      // PERMANENT error is not queued: replaying it would be pure noise.
      await manager.deliver({
        id: 'bad-1', createdAt: new Date().toISOString(), workspaceId: 'ws-1', title: 't', body: 'b',
        deliverTo: ['telegram'],
      })
      expect(deliver).toHaveBeenCalledTimes(1)
      await manager.retryPending(Date.now() + 60_000)
      expect(deliver).toHaveBeenCalledTimes(1)
    } finally {
      await manager.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('survives a restart: a queued alert is delivered by the next process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'delivery-restart-'))
    const path = join(dir, 'pending.json')
    const make = (ready: boolean, sink: InboxNotification[]) => {
      const registry = new ConnectorRegistry()
      registry.register({
        definition: { id: 'telegram', label: 'Telegram', description: 'Telegram.', fields: [], commands: [] },
        create: () => ({
          id: 'telegram',
          start: async () => undefined,
          stop: async () => undefined,
          deliver: async (notification: InboxNotification) => {
            if (!ready) throw new Error('Telegram bot is not ready')
            sink.push(notification)
          },
          sendOwnerText: async () => undefined,
          health: () => ({ id: 'telegram', enabled: true, status: 'healthy' as const }),
        }),
      })
      return new DeliveryManager({
        registry,
        config: { version: 1, adapters: { telegram: { enabled: true, settings: {} } } },
        updateAdapterSettings: vi.fn(),
        pendingDeliveryPath: path,
      })
    }
    const sink: InboxNotification[] = []
    const before = make(false, [])
    const after = make(true, sink)
    try {
      await before.start()
      await before.deliver({
        id: 'alert-restart', createdAt: new Date().toISOString(), workspaceId: 'ws-1',
        title: 't', body: 'b', deliverTo: ['telegram'],
      })
      await before.stop()
      // The next process adopts the queue and delivers it, which is the whole
      // point: a trigger that fired during the restart window still reaches the
      // operator instead of vanishing.
      await after.start()
      await after.retryPending(Date.now() + 60_000)
      expect(sink.map((item) => item.id)).toEqual(['alert-restart'])
    } finally {
      await before.stop()
      await after.stop()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

  it('keeps the historical fan-out when no allow-list is present', async () => {    const create = (id: string) => {
      const deliver = vi.fn(async () => undefined)
      return { id, deliver }
    }
    const alpha = create('alpha')
    const beta = create('beta')
    const registry = new ConnectorRegistry()
    for (const adapter of [alpha, beta]) {
      registry.register({
        definition: { id: adapter.id, label: adapter.id, description: `${adapter.id} adapter.`, fields: [], commands: [] },
        create: () => ({
          id: adapter.id,
          start: async () => undefined,
          stop: async () => undefined,
          deliver: adapter.deliver,
          sendOwnerText: async () => undefined,
          health: () => ({ id: adapter.id, enabled: true, status: 'healthy' as const }),
        }),
      })
    }
    const manager = new DeliveryManager({
      registry,
      config: {
        version: 1,
        adapters: {
          alpha: { enabled: true, settings: { inboxPush: true } },
          beta: { enabled: true, settings: { inboxPush: true } },
        },
      },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()

    await manager.deliver({
      id: 'inbox-plain',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      title: 'Ordinary Inbox item',
      body: '',
    })

    expect(alpha.deliver).toHaveBeenCalledOnce()
    expect(beta.deliver).toHaveBeenCalledOnce()
    await manager.stop()
  })

  it('contains asynchronous owner-chat failures after accepting the projection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'broken', label: 'Broken', description: 'Broken adapter.', fields: [], commands: [] },
      create: () => ({
        id: 'broken',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async () => undefined,
        sendOwnerText: async () => { throw new Error('owner chat offline') },
        health: () => ({ id: 'broken', enabled: true, status: 'degraded' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { broken: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()

    expect(manager.enqueueOwnerChat({
      id: 'desk-comment-1',
      adapterId: 'broken',
      conversationId: 'comment-1',
      phase: 'final',
      text: 'hello',
    }))
      .toEqual({ accepted: true, deliveryId: 'desk-comment-1' })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[connector] broken owner-chat delivery failed:',
      'owner chat offline',
    ))
    warn.mockRestore()
  })

  it('treats an online bot waiting for /link as an intentional setup phase', async () => {
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'unlinked', label: 'Unlinked', description: 'Waiting for owner.', fields: [], commands: [] },
      create: () => ({
        id: 'unlinked',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async () => { throw new Error('owner not linked') },
        sendOwnerText: async () => undefined,
        health: () => ({ id: 'unlinked', enabled: true, status: 'awaiting_link' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { unlinked: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
    })

    await manager.start()

    expect(manager.health()).toMatchObject({
      status: 'healthy',
      adapters: [{ id: 'unlinked', status: 'awaiting_link' }],
    })
  })

  it('records replayable ingress and per-adapter delivery results', async () => {
    const recorder = new MemoryRecorder()
    const adapter = new FakeThirdPartyAdapter()
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: adapter.id, label: 'Fake', description: 'Fake.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      recorder,
      config: { version: 1, adapters: { [adapter.id]: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
      workQueue: new MemoryWorkQueue(),
    })
    await manager.start()
    const content = Buffer.from('# Report\n')
    const source = Buffer.from('# Source report\n')
    const receipt = manager.enqueue({
      id: 'inbox-recorded',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-1',
      title: 'Replay me',
      body: 'Recorded payload',
      attachments: [{
        filename: 'report.md',
        mediaType: 'text/markdown; charset=utf-8',
        sizeBytes: content.byteLength,
        contentSha256: createHash('sha256').update(content).digest('hex'),
        source: {
          sizeBytes: source.byteLength,
          contentSha256: createHash('sha256').update(source).digest('hex'),
          detectedEncoding: 'windows-1252',
          detectionConfidence: 35,
        },
        contentBase64: content.toString('base64'),
      }],
    })

    await vi.waitFor(() => expect(adapter.delivered).toHaveLength(1))
    expect(recorder.events.map((event) => event.stage)).toEqual([
      'notification.received',
      'delivery.attempted',
      'delivery.succeeded',
    ])
    expect(recorder.events.every((event) => event.correlationId === receipt.deliveryId)).toBe(true)
    expect(recorder.events[0]?.payload).toMatchObject({ notification: { id: 'inbox-recorded' } })
    expect(adapter.delivered[0]?.attachments?.[0]?.contentBase64).toBe(content.toString('base64'))
    expect(recorder.events[0]?.payload).toMatchObject({
      attachmentEvidence: [{
        filename: 'report.md',
        sizeBytes: content.byteLength,
        source: {
          sizeBytes: source.byteLength,
          detectedEncoding: 'windows-1252',
        },
        normalized: true,
      }],
    })
    expect(JSON.stringify(recorder.events)).not.toContain(content.toString('base64'))
  })

  it('does not let a broken recorder block external delivery', async () => {
    const adapter = new FakeThirdPartyAdapter()
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: adapter.id, label: 'Fake', description: 'Fake.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      recorder: { record: async () => { throw new Error('disk full') } },
      config: { version: 1, adapters: { [adapter.id]: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()
    await manager.deliver({
      id: 'inbox-no-log', createdAt: new Date().toISOString(), workspaceId: 'ws-1', title: 'Still send', body: '',
    })
    expect(adapter.delivered).toHaveLength(1)
  })

  it('keeps artifact requests bounded, TTL-limited, and separate from phone-desk inbound', async () => {
    const now = Date.parse('2026-08-14T15:02:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const adapter = new FakeThirdPartyAdapter()
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: adapter.id, label: 'Fake', description: 'Fake.', fields: [], commands: [] },
      create: () => adapter,
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { [adapter.id]: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
      workQueue: new MemoryWorkQueue(),
    })
    try {
      await manager.start()

      const requestId = await manager.enqueueArtifactRequest(adapter.id, { entryId: 'entry-1', docIndex: 0 })
      expect(requestId.startsWith('art-')).toBe(true)
      await manager.acceptInbound({ connectorId: adapter.id, userId: '1', text: 'desk' })
      expect(await drainInbound(manager)).toEqual([
        { connectorId: adapter.id, userId: '1', text: 'desk' },
      ])
      expect(await drainActions(manager)).toEqual([expect.objectContaining({
        requestId,
        connectorId: adapter.id,
        entryId: 'entry-1',
        docIndex: 0,
      })])
      expect(await drainActions(manager)).toEqual([])

      await manager.enqueueArtifactRequest(adapter.id, { entryId: 'stale', docIndex: 1 })
      vi.setSystemTime(now + 60_001)
      expect(await drainActions(manager)).toEqual([expect.objectContaining({
        connectorId: adapter.id,
        entryId: 'stale',
        docIndex: 1,
      })])

      for (let index = 0; index < 20; index += 1) {
        await manager.enqueueArtifactRequest(adapter.id, { entryId: `entry-${index}`, docIndex: 0 })
      }
      await expect(manager.enqueueArtifactRequest(adapter.id, { entryId: 'overflow', docIndex: 0 }))
        .rejects.toThrow('queue is full')
    } finally {
      vi.useRealTimers()
      await manager.stop()
    }
  })

  it('leaves request expiry to Alice after a durable claim', async () => {
    const now = Date.parse('2026-08-14T15:02:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const notices: string[] = []
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'telegram', label: 'Telegram', description: 'Telegram.', fields: [], commands: [] },
      create: () => ({
        id: 'telegram',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async () => undefined,
        sendOwnerText: async (text) => { notices.push(text) },
        health: () => ({ id: 'telegram', enabled: true, status: 'healthy' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { telegram: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
      workQueue: new MemoryWorkQueue(),
    })
    try {
      await manager.start()
      await manager.enqueueArtifactRequest('telegram', { entryId: 'stale', docIndex: 0 })
      vi.setSystemTime(now + 60_001)
      await manager.enqueueArtifactRequest('telegram', { entryId: 'fresh', docIndex: 0 })
      expect(notices).toEqual([])
      expect(await drainActions(manager)).toEqual([
        expect.objectContaining({ entryId: 'stale' }),
        expect.objectContaining({ entryId: 'fresh' }),
      ])
    } finally {
      vi.useRealTimers()
      await manager.stop()
    }
  })

  it('keeps UTA review requests off the Inbox artifact drain', async () => {
    const presented: unknown[] = []
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'telegram', label: 'Telegram', description: 'Telegram.', fields: [], commands: [] },
      create: () => ({
        id: 'telegram',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async () => undefined,
        sendOwnerText: async () => undefined,
        presentUta: async (presentation) => { presented.push(presentation) },
        health: () => ({ id: 'telegram', enabled: true, status: 'healthy' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { telegram: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
      workQueue: new MemoryWorkQueue(),
    })
    await manager.start()
    const requestId = await manager.enqueueUtaRequest('telegram', { action: 'review' })
    expect(requestId.startsWith('uta-')).toBe(true)
    expect(await drainActions(manager)).toEqual([])
    expect(await drainUtaActions(manager)).toEqual([expect.objectContaining({
      requestId,
      connectorId: 'telegram',
      action: 'review',
    })])
    await manager.presentUta({
      requestId,
      connectorId: 'telegram',
      review: {
        generatedAt: '2026-08-19T12:00:00.000Z',
        accounts: [{
          id: 'alpaca-paper',
          label: 'Alpaca paper',
          pendingMessage: 'long AAPL',
          pendingHash: 'abc12345',
          stagedCount: 1,
          hiddenOperationCount: 0,
          operations: [{ action: 'placeOrder', summary: 'BUY AAPL MKT × 10' }],
        }],
      },
    })
    expect(presented).toHaveLength(1)
    await manager.stop()
  })

  it('delivers an artifact only to the requesting connector', async () => {
    const content = Buffer.from('# Current\n')
    const telegramDelivered: unknown[] = []
    const otherDelivered: InboxNotification[] = []
    const otherArtifacts: unknown[] = []
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'telegram', label: 'Telegram', description: 'Telegram.', fields: [], commands: [] },
      create: () => ({
        id: 'telegram',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async () => undefined,
        sendOwnerText: async () => undefined,
        deliverArtifact: async (delivery) => { telegramDelivered.push(delivery) },
        health: () => ({ id: 'telegram', enabled: true, status: 'healthy' as const }),
      }),
    })
    registry.register({
      definition: { id: 'discord', label: 'Discord', description: 'Discord.', fields: [], commands: [] },
      create: () => ({
        id: 'discord',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async (notification) => { otherDelivered.push(notification) },
        sendOwnerText: async () => undefined,
        deliverArtifact: async (delivery) => { otherArtifacts.push(delivery) },
        health: () => ({ id: 'discord', enabled: true, status: 'healthy' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: {
        version: 1,
        adapters: {
          telegram: { enabled: true, settings: {} },
          discord: { enabled: true, settings: {} },
        },
      },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()
    await manager.deliverArtifact({
      requestId: 'art-1',
      connectorId: 'telegram',
      entryId: 'entry-1',
      docIndex: 0,
      attachment: {
        filename: 'close.md',
        mediaType: 'text/markdown',
        sizeBytes: content.byteLength,
        contentSha256: createHash('sha256').update(content).digest('hex'),
        contentBase64: content.toString('base64'),
      },
    })
    expect(telegramDelivered).toHaveLength(1)
    expect(otherArtifacts).toEqual([])
    expect(otherDelivered).toEqual([])
    await manager.stop()
  })

  it('does not treat a directed artifact as an Inbox notification', async () => {
    const delivered: InboxNotification[] = []
    const artifacts: unknown[] = []
    const registry = new ConnectorRegistry()
    registry.register({
      definition: { id: 'telegram', label: 'Telegram', description: 'Telegram.', fields: [], commands: [] },
      create: () => ({
        id: 'telegram',
        start: async () => undefined,
        stop: async () => undefined,
        deliver: async (notification) => { delivered.push(notification) },
        sendOwnerText: async () => undefined,
        deliverArtifact: async (delivery) => { artifacts.push(delivery) },
        health: () => ({ id: 'telegram', enabled: true, status: 'healthy' as const }),
      }),
    })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { telegram: { enabled: true, settings: {} } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()
    const content = Buffer.from('note')
    await manager.deliverArtifact({
      requestId: 'art-2',
      connectorId: 'telegram',
      entryId: 'entry-2',
      docIndex: 1,
      attachment: {
        filename: 'note.txt',
        mediaType: 'application/octet-stream',
        sizeBytes: content.byteLength,
        contentSha256: createHash('sha256').update(content).digest('hex'),
        contentBase64: content.toString('base64'),
      },
    })
    expect(delivered).toEqual([])
    expect(artifacts).toHaveLength(1)
    await manager.stop()
  })
})

it('owns reply syntax, sends final files once, and preserves ordinary syntax discussions', async () => {
  const adapter = new FakeThirdPartyAdapter() as FakeThirdPartyAdapter & {
    sendOwnerChat: ReturnType<typeof vi.fn>; sendOwnerFile: ReturnType<typeof vi.fn>
  }
  adapter.sendOwnerChat = vi.fn(async () => undefined)
  adapter.sendOwnerFile = vi.fn(async () => undefined)
  const warning = vi.spyOn(adapter, 'sendOwnerText')
  const registry = new ConnectorRegistry()
  registry.register({ definition: { id: adapter.id, label: 'Test', description: '', fields: [], commands: [] }, create: () => adapter })
  const read = vi.fn(async () => ({ filename: 'a.pdf', mediaType: 'application/pdf', sizeBytes: 0, contentBase64: '', contentSha256: createHash('sha256').update('').digest('hex') }))
  const manager = new DeliveryManager({ registry, config: { version: 1, adapters: { [adapter.id]: { enabled: true, settings: {} } } }, updateAdapterSettings: vi.fn(), readWorkspaceFile: read })
  await manager.start()
  const base = { adapterId: adapter.id, conversationId: 'turn', workspaceId: 'ws' }
  await manager.sendOwnerChat({ ...base, id: 'progress', phase: 'progress', text: 'Preparing [[a.pdf]]' })
  expect(read).not.toHaveBeenCalled()
  await manager.sendOwnerChat({ ...base, id: 'progress', phase: 'final', text: 'Final text' })
  expect(adapter.sendOwnerChat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'final', text: 'Final text' }))
  const final = { ...base, conversationId: 'files-turn', id: 'final', phase: 'final' as const, text: 'Done [[a.pdf]] [[a.pdf]]' }
  await Promise.all([manager.sendOwnerChat(final), manager.sendOwnerChat(final)])
  expect(read).toHaveBeenCalledExactlyOnceWith('ws', 'a.pdf')
  expect(adapter.sendOwnerFile).toHaveBeenCalledOnce()
  await manager.sendOwnerChat({ ...base, conversationId: 'silent-turn', id: 'silent', phase: 'final', source: 'automation', text: '[[no-reply]] [[b.pdf]]' })
  expect(adapter.sendOwnerChat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'final', text: undefined }))
  expect(read).toHaveBeenCalledOnce()
  await manager.sendOwnerChat({ ...base, conversationId: 'literal-turn', id: 'literal', phase: 'final', source: 'conversation', text: 'We discussed [[no-reply]]' })
  expect(adapter.sendOwnerChat).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'We discussed [[no-reply]]' }))
  read.mockRejectedValueOnce(new Error('missing'))
  await manager.sendOwnerChat({ ...base, conversationId: 'missing-turn', id: 'missing', phase: 'final', text: '[[missing.pdf]]' })
  expect(adapter.sendOwnerChat).toHaveBeenLastCalledWith(expect.objectContaining({ text: '[[missing.pdf]]' }))
  expect(warning).not.toHaveBeenCalled()
  adapter.sendOwnerFile.mockRejectedValueOnce(new Error('upload failed'))
  await manager.sendOwnerChat({ ...base, conversationId: 'upload-failed-turn', id: 'upload-failed', phase: 'final', text: '[[a.pdf]]' })
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('Upload failed'))
  read.mockClear()
  await manager.sendOwnerChat({ ...base, conversationId: 'limit-turn', id: 'limit', phase: 'final', text: Array.from({ length: 6 }, (_, i) => `[[${i}.pdf]]`).join(' ') })
  expect(read).toHaveBeenCalledTimes(5)
  expect(warning).toHaveBeenLastCalledWith('[[5.pdf]]')
  await manager.sendOwnerChat({ ...base, conversationId: 'sticker-turn', id: 'sticker', phase: 'final', text: '[[sticker/hello.png]]' })
  expect(adapter.sendOwnerFile).toHaveBeenLastCalledWith(expect.any(Object), 'sticker')
  const order: string[] = []
  adapter.sendOwnerChat.mockImplementation(async message => { order.push(message.text ?? 'finish') })
  adapter.sendOwnerFile.mockImplementation(async () => { order.push('sticker') })
  warning.mockImplementation(async text => { order.push(text) })
  await manager.sendOwnerChat({ ...base, conversationId: 'interleaved-turn', id: 'interleaved', phase: 'final', text: 'Before [[sticker/hello.png]] After' })
  expect(order).toEqual(['Before', 'sticker', 'After'])
  await manager.stop()
})

it('renders market snapshots in prose order without Workspace files, and retains failures', async () => {
  const adapter = new FakeThirdPartyAdapter() as FakeThirdPartyAdapter & {
    sendOwnerChat: ReturnType<typeof vi.fn>; sendOwnerFile: ReturnType<typeof vi.fn>
  }
  const order: string[] = []
  adapter.sendOwnerChat = vi.fn(async message => { order.push(message.text ?? '') })
  adapter.sendOwnerFile = vi.fn(async (_file, media) => { order.push(media) })
  vi.spyOn(adapter, 'sendOwnerText').mockImplementation(async text => { order.push(text) })
  const registry = new ConnectorRegistry()
  registry.register({ definition: { id: adapter.id, label: 'Test', description: '', fields: [], commands: [] }, create: () => adapter })
  const read = vi.fn()
  const renderMarket = vi.fn(async () => ({ filename: 'chart.png', mediaType: 'image/png', sizeBytes: 0, contentBase64: '', contentSha256: createHash('sha256').update('').digest('hex') }))
  const manager = new DeliveryManager({ registry, config: { version: 1, adapters: { [adapter.id]: { enabled: true, settings: {} } } }, updateAdapterSettings: vi.fn(), readWorkspaceFile: read, renderMarket })
  await manager.start()
  try {
    const base = { adapterId: adapter.id, conversationId: 'market', phase: 'final' as const }
    const reference = 'market/alpaca|BTC/USD/1h'
    await manager.sendOwnerChat({ ...base, id: 'ok', text: `Before [[${reference}]] After` })
    expect(order).toEqual(['Before', 'image', 'After'])
    expect(read).not.toHaveBeenCalled()
    expect(renderMarket).toHaveBeenCalledExactlyOnceWith(reference)
    renderMarket.mockRejectedValueOnce(new Error('no bars'))
    order.length = 0
    await manager.sendOwnerChat({ ...base, conversationId: 'bad-turn', id: 'bad', text: `[[${reference}]]` })
    expect(order.join(' ')).toContain(`[[${reference}]]`)
    expect(order.join(' ')).toContain('Chart unavailable')
    await manager.sendOwnerChat({ ...base, conversationId: 'silent-turn', id: 'silent', source: 'automation', text: `[[no-reply]] [[${reference}]]` })
    expect(renderMarket).toHaveBeenCalledTimes(2)
  } finally { await manager.stop() }
})

it('shares terminal ordering and renewable activity leases across adapters', async () => {
  vi.useFakeTimers()
  const adapter = Object.assign(new FakeThirdPartyAdapter(), { sendOwnerChat: vi.fn(async () => {}), stopOwnerActivity: vi.fn(async () => {}) })
  const registry = new ConnectorRegistry()
  registry.register({ definition: { id: adapter.id, label: 'Test', description: 'Test', fields: [], commands: [] }, create: () => adapter })
  const manager = new DeliveryManager({ registry, config: { version: 1, adapters: { [adapter.id]: { enabled: true, settings: {} } } }, updateAdapterSettings: vi.fn(), recorder: new MemoryRecorder() })
  try {
    await manager.start()
    const base = { adapterId: adapter.id, conversationId: 'run', activityLeaseMs: 1000 }
    await manager.sendOwnerChat({ ...base, id: 'start', phase: 'accepted' })
    await vi.advanceTimersByTimeAsync(900)
    await manager.sendOwnerChat({ ...base, id: 'heartbeat', phase: 'accepted' })
    await vi.advanceTimersByTimeAsync(900)
    expect(adapter.stopOwnerActivity).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(101)
    expect(adapter.stopOwnerActivity).toHaveBeenCalledExactlyOnceWith('run')
    // Lease expiry is not execution completion: recovered Alice can renew activity.
    await manager.sendOwnerChat({ ...base, id: 'recovered', phase: 'accepted' })
    await manager.sendOwnerChat({ ...base, id: 'end', phase: 'final' })
    const calls = adapter.sendOwnerChat.mock.calls.length
    await manager.sendOwnerChat({ ...base, id: 'late', phase: 'progress', text: 'old' })
    await manager.sendOwnerChat({ ...base, id: 'late-start', phase: 'accepted' })
    await manager.sendOwnerChat({ ...base, id: 'duplicate-final', phase: 'final', text: 'duplicate' })
    expect(adapter.sendOwnerChat).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(2000)
    expect(adapter.stopOwnerActivity).toHaveBeenCalledTimes(2)
  } finally { await manager.stop(); vi.useRealTimers() }
})

// A live turn reuses ONE message id and `phase: 'progress'` so the transport
// edits a single ephemeral slot in place. Deduping those on id+phase alone
// registered the key on frame one and dropped every later frame, which froze
// the Telegram card on its opening `read` while bash commands kept running.
it('delivers every distinct progress frame that reuses one activity id', async () => {
  const adapter = new FakeThirdPartyAdapter() as FakeThirdPartyAdapter & {
    sendOwnerChat: ReturnType<typeof vi.fn>
  }
  adapter.sendOwnerChat = vi.fn(async () => undefined)
  const registry = new ConnectorRegistry()
  registry.register({ definition: { id: adapter.id, label: 'Test', description: '', fields: [], commands: [] }, create: () => adapter })
  const manager = new DeliveryManager({ registry, config: { version: 1, adapters: { [adapter.id]: { enabled: true, settings: {} } } }, updateAdapterSettings: vi.fn(), readWorkspaceFile: vi.fn() })
  await manager.start()
  try {
    const base = { adapterId: adapter.id, conversationId: 'live', id: 'desk-progress-live', phase: 'progress' as const }
    await manager.sendOwnerChat({ ...base, activity: { toolCalls: 1, toolFailures: 0, currentTool: 'read_file' } })
    await manager.sendOwnerChat({ ...base, activity: { toolCalls: 2, toolFailures: 0, currentTool: 'Bash' } })
    // An identical resend still collapses rather than re-editing the slot.
    await manager.sendOwnerChat({ ...base, activity: { toolCalls: 2, toolFailures: 0, currentTool: 'Bash' } })
    expect(adapter.sendOwnerChat).toHaveBeenCalledTimes(2)
  } finally { await manager.stop() }
})

function boardSync() {
  return {
    refreshSeconds: 5,
    items: [{
      watcherId: 'w-1',
      workspaceId: 'ws-1',
      title: 'BTC setup',
      running: true,
      pollable: true,
      pollSeconds: 5,
      spec: { pair: 'BTCUSDT' },
      state: {},
      nowIso: new Date().toISOString(),
    }],
  }
}

function boardRegistry(options: { ignoresInboxPush?: boolean } = {}) {
  const syncWatcherBoard = vi.fn(async () => undefined)
  const registry = new ConnectorRegistry()
  registry.register({
    definition: { id: 'boarded', label: 'Boarded', description: 'Board adapter.', fields: [], commands: [] },
    create: () => ({
      id: 'boarded',
      start: async () => undefined,
      stop: async () => undefined,
      deliver: async () => undefined,
      sendOwnerText: async () => undefined,
      syncWatcherBoard,
      ...(options.ignoresInboxPush ? { boardIgnoresInboxPush: () => true } : {}),
      health: () => ({ id: 'boarded', enabled: true, status: 'healthy' as const }),
    }),
  })
  return { registry, syncWatcherBoard }
}

describe('watcher board fan-out gate', () => {
  it('skips a board whose adapter obeys the Inbox-push toggle', async () => {
    const { registry, syncWatcherBoard } = boardRegistry()
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { boarded: { enabled: true, settings: { inboxPush: false } } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()
    await manager.syncWatcherBoard(boardSync())
    // The shared gate still governs an auto-posting board such as Discord's.
    expect(syncWatcherBoard).not.toHaveBeenCalled()
    await manager.stop()
  })

  it('keeps an opted-out board alive while Inbox push is off', async () => {
    const { registry, syncWatcherBoard } = boardRegistry({ ignoresInboxPush: true })
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { boarded: { enabled: true, settings: { inboxPush: false } } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()
    await manager.syncWatcherBoard(boardSync())
    // A board the operator opened explicitly must not die with a notification
    // preference it has nothing to do with.
    expect(syncWatcherBoard).toHaveBeenCalledOnce()
    await manager.stop()
  })

  it('still fans out when Inbox push is on', async () => {
    const { registry, syncWatcherBoard } = boardRegistry()
    const manager = new DeliveryManager({
      registry,
      config: { version: 1, adapters: { boarded: { enabled: true, settings: { inboxPush: true } } } },
      updateAdapterSettings: vi.fn(),
    })
    await manager.start()
    await manager.syncWatcherBoard(boardSync())
    expect(syncWatcherBoard).toHaveBeenCalledOnce()
    await manager.stop()
  })
})
