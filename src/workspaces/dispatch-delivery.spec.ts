import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HeadlessTaskRegistry } from './headless-task-registry.js'
import type { Logger } from './logger.js'
import { buildDispatchCommunication } from './dispatch-communication.js'
import type { OwnerChatMessage } from '@traderalice/connector-protocol'
import { DispatchDelivery } from './dispatch-delivery.js'

let home: string
let tasks: HeadlessTaskRegistry
const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'dispatch-delivery-')); tasks = await HeadlessTaskRegistry.load(join(home, 'tasks.json'), logger) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
async function task(external = true) {
  return tasks.create({ wsId: 'execution', resumeId: 'resume-1', agent: 'codex', prompt: 'hello', startedAt: 1,
    communication: buildDispatchCommunication({ target: { workspaceId: 'execution', resumeId: 'resume-1', agent: 'codex' },
      ...(external ? { trigger: { kind: 'issue', workspaceId: 'issue', issueId: 'desk' }, desk: { connectorId: 'telegram' } } : {}),
    }),
  })
}
const snapshot = { updatedAt: 1, assistantText: 'checking', blocks: [{ type: 'text' as const, text: 'checking' }, { type: 'tool' as const, id: 't', name: 'read', status: 'running' as const }], metrics: { textBlocks: 1, toolCalls: 1, toolFailures: 0 } }
function setup() {
  const sendOwnerMessage = vi.fn(async (_message: OwnerChatMessage, _signal?: AbortSignal) => ({ accepted: true as const, deliveryId: 'ok' }))
  const warn = vi.fn()
  return { sendOwnerMessage, warn, delivery: new DispatchDelivery(tasks, warn, { sendOwnerMessage }) }
}
it('uses one immutable destination and task identity from acceptance through final', async () => {
  const run = await task(); const { delivery, sendOwnerMessage } = setup()
  await delivery.accepted(run); await delivery.offer(run, snapshot)
  await tasks.complete(run.taskId, { status: 'done' }); await delivery.finish(run, 'done')
  expect(sendOwnerMessage.mock.calls.map(call => call[0])).toEqual([
    expect.objectContaining({ phase: 'accepted', conversationId: run.taskId, activityLeaseMs: 60000 }),
    // Progress carries structured activity and no prose: the transport renders
    // (and animates) its own ephemeral slot from this.
    expect.objectContaining({
      phase: 'progress',
      conversationId: run.taskId,
      activity: expect.objectContaining({ toolCalls: 1, currentTool: 'read', recentTools: [{ name: 'read', status: 'running' }] }),
    }),
    expect.objectContaining({ phase: 'final', text: 'done', conversationId: run.taskId, workspaceId: 'execution', source: 'automation' }),
  ])
  await delivery.offer(run, snapshot); await delivery.finish(run, 'duplicate'); await delivery.reconcile()
  expect(sendOwnerMessage).toHaveBeenCalledTimes(3)
})
it.each(['done', 'failed', 'interrupted'] as const)('closes %s without requiring assistant text or a saved comment', async status => {
  const run = await task(); const { delivery, sendOwnerMessage } = setup()
  await delivery.accepted(run); await tasks.complete(run.taskId, { status }); await delivery.finish(run)
  expect(sendOwnerMessage.mock.calls.at(-1)?.[0]).toMatchObject({ phase: status === 'done' ? 'final' : 'failed', conversationId: run.taskId })
  expect(run.terminalDelivery?.state).toBe('accepted')
})
it('never sends activity or completion for a private run', async () => {
  const run = await task(false); const { delivery, sendOwnerMessage } = setup()
  await delivery.accepted(run); await delivery.offer(run, snapshot); await tasks.complete(run.taskId, { status: 'done' }); await delivery.finish(run, 'secret')
  expect(sendOwnerMessage).not.toHaveBeenCalled()
})
it('recovers an interrupted run after Alice restarts, preserving its saved route', async () => {
  const run = await task(); tasks = await HeadlessTaskRegistry.load(join(home, 'tasks.json'), logger)
  const { delivery, sendOwnerMessage } = setup(); await delivery.reconcile()
  expect(sendOwnerMessage.mock.calls[0]?.[0]).toMatchObject({ phase: 'failed', conversationId: run.taskId, adapterId: 'telegram' })
})
it('closes uncertain delivery without replaying the public reply after restart', async () => {
  const run = await task(); const { delivery, sendOwnerMessage } = setup()
  await tasks.complete(run.taskId, { status: 'done' }); sendOwnerMessage.mockRejectedValueOnce(new Error('receipt lost'))
  await delivery.finish(run, 'private report [[report.pdf]]')
  expect(run.status).toBe('done'); expect(run.terminalDelivery?.state).toBe('uncertain')
  tasks = await HeadlessTaskRegistry.load(join(home, 'tasks.json'), logger)
  const resumed = setup(); await resumed.delivery.reconcile(); await resumed.delivery.reconcile()
  expect(resumed.sendOwnerMessage).toHaveBeenCalledTimes(1)
  expect(resumed.sendOwnerMessage.mock.calls[0]?.[0]).toMatchObject({ phase: 'final', conversationId: run.taskId })
  expect(resumed.sendOwnerMessage.mock.calls[0]?.[0]).not.toHaveProperty('text')
  expect(tasks.get(run.taskId)?.terminalDelivery).toMatchObject({ state: 'closed', error: 'Error: receipt lost' })
})
async function conversationTask() {
  return tasks.create({ wsId: 'execution', resumeId: 'resume-1', agent: 'codex', prompt: 'hi', startedAt: 1,
    communication: buildDispatchCommunication({
      target: { workspaceId: 'execution', resumeId: 'resume-1', agent: 'codex' },
      inquiry: {
        subject: { kind: 'issue', workspaceId: 'issue', issueId: 'desk', relation: 'owner', commentId: 'c1' },
        question: 'hi', resolution: { mode: 'reconstructed' },
      },
      desk: { connectorId: 'telegram' },
    }),
  })
}
it('tells a conversation sender when a completed run produced no reply', async () => {
  const run = await conversationTask(); const { delivery, sendOwnerMessage } = setup()
  await tasks.complete(run.taskId, { status: 'done' }); await delivery.finish(run, null)
  const last = sendOwnerMessage.mock.calls.at(-1)?.[0]
  expect(last).toMatchObject({ phase: 'final', source: 'conversation' })
  expect(last?.text).toMatch(/without a reply/i)
})
it('keeps an automation wake silent when it completes with nothing to say', async () => {
  const run = await task(); const { delivery, sendOwnerMessage } = setup()
  await tasks.complete(run.taskId, { status: 'done' }); await delivery.finish(run, null)
  expect(sendOwnerMessage.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'final', source: 'automation' })
  expect(sendOwnerMessage.mock.calls.at(-1)?.[0]?.text).toBeUndefined()
})
it('does not send a historical task merely because it has a desk trigger', async () => {
  await tasks.create({ wsId: 'w', resumeId: 'r', agent: 'codex', prompt: 'old', startedAt: 1, trigger: { kind: 'issue', workspaceId: 'w', issueId: 'desk', metadata: { kind: 'connector-cron-issue', connectorId: 'telegram' } } })
  tasks = await HeadlessTaskRegistry.load(join(home, 'tasks.json'), logger)
  const { delivery, sendOwnerMessage } = setup(); await delivery.reconcile(); expect(sendOwnerMessage).not.toHaveBeenCalled()
})
