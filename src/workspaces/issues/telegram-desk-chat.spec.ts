import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConnectorClient } from '@traderalice/connector-protocol'

import { createTelegramConnectorDesk } from './telegram-connector.js'
import {
  formatTelegramInboundStack,
  ingestTelegramOwnerMessage,
  ingestTelegramOwnerMessages,
  pullTelegramDeskInbound,
  startTelegramDeskInboundPoll,
  shouldProjectDeskComment,
  stampTelegramDeskScheduledFire,
  telegramDeskHasRunningWork,
  findRunningDeskTask,
  type TelegramDeskChatHost,
} from './telegram-desk-chat.js'
import { readIssueComments } from './comments.js'

let home: string
let wsDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tg-desk-chat-'))
  wsDir = join(home, 'ws')
  await mkdir(join(wsDir, '.alice', 'issues'), { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function host(overrides: Partial<TelegramDeskChatHost> = {}): TelegramDeskChatHost {
  return {
    listWorkspaces: () => [{ id: 'ws-a', dir: wsDir }],
    getWorkspace: (id) => id === 'ws-a' ? { id: 'ws-a', dir: wsDir } : undefined,
    provenanceStore: () => ({
      append: async () => undefined,
      list: () => [],
      latest: () => undefined,
    } as unknown as NonNullable<ReturnType<TelegramDeskChatHost['provenanceStore']>>),
    conversation: () => undefined,
    ...overrides,
  }
}

function mockClient() {
  const sent: Array<{ id: string; conversationId: string; phase: string; text?: string }> = []
  const client = {
    sendOwnerMessage: async (message: { id: string; conversationId: string; phase: string; text?: string }) => {
      sent.push(message)
      return { accepted: true }
    },
  } as unknown as ConnectorClient
  return { client, sent }
}

describe('telegram desk chat filter', () => {
  it('finds only the in-flight turn for the desk', () => {
    const desk = { wsId: 'ws-a', issue: { id: 'telegram-phone-desk' } }
    const running = {
      taskId: 'run-1', status: 'running' as const,
      trigger: { kind: 'issue' as const, workspaceId: 'ws-a', issueId: 'telegram-phone-desk' },
    }
    expect(telegramDeskHasRunningWork([running], desk)).toBe(true)
    expect(findRunningDeskTask([running as never], desk)?.taskId).toBe('run-1')
    expect(findRunningDeskTask([{ ...running, status: 'done' } as never], desk)).toBeUndefined()
    expect(findRunningDeskTask([{ ...running, trigger: { kind: 'issue' as const, workspaceId: 'ws-a', issueId: 'other' } } as never], desk)).toBeUndefined()
  })

  it('projects agent comments, including syntax discussions, and skips inbound telegram', () => {
    const issue = { connectorDesk: 'telegram' }
    expect(shouldProjectDeskComment(issue, {
      id: 'c1', author: '@resume-a', at: 'now', markdown: 'Hello from the desk.',
    })).toBe(true)
    expect(shouldProjectDeskComment(issue, {
      id: 'c2', author: 'human', at: 'now', markdown: 'From Telegram', via: 'telegram',
    })).toBe(false)
    expect(shouldProjectDeskComment(issue, {
      id: 'c3', author: '@resume-a', at: 'now', markdown: '[[no-reply]] nothing to say',
    })).toBe(true)
    expect(shouldProjectDeskComment(issue, {
      id: 'c3', author: '@resume-a', at: 'now', markdown: '[[no-reply]] nothing to say',
    }, {
      triggerMetadata: { kind: 'connector-cron-issue', connectorId: 'telegram' },
    })).toBe(true)
    expect(shouldProjectDeskComment({}, {
      id: 'c4', author: '@resume-a', at: 'now', markdown: 'ordinary issue',
    })).toBe(false)
  })


})

describe('telegram desk ingest and stamp', () => {
  it('refuses inbound when the phone desk is disabled', async () => {
    const result = await ingestTelegramOwnerMessage(host(), {
      connectorId: 'telegram',
      userId: '42',
      text: 'Anybody home?',
    })
    expect(result).toEqual({ ok: false, reason: 'desk_disabled' })
  })

  it('records an inbound owner DM as a human comment that does not echo', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const { client } = mockClient()
    const result = await ingestTelegramOwnerMessage(host(), {
      connectorId: 'telegram',
      userId: '42',
      text: 'What is the overnight risk?',
    }, client)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.comment.author).toBe('human')
    expect(result.comment.via).toBe('telegram')
    expect(result.comment.markdown).toBe('What is the overnight risk?')
    expect(shouldProjectDeskComment(created.ok ? created.issue : { connectorDesk: 'telegram' }, result.comment)).toBe(false)
  })

  it('writes an inbound image into the workspace and references it in the comment', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const { client } = mockClient()
    // One-pixel PNG; the store only needs valid bytes, not a decodable image.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const result = await ingestTelegramOwnerMessage(host(), {
      connectorId: 'telegram',
      userId: '42',
      text: 'What is this setup?',
      attachments: [{
        filename: 'chart.png',
        mediaType: 'image/png',
        sizeBytes: png.byteLength,
        contentBase64: png.toString('base64'),
      }],
    }, client)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.comment.markdown).toContain('What is this setup?')
    expect(result.comment.markdown).toContain('![image](.alice/inbox-media/')

    // The referenced file must actually exist, or the agent would read nothing.
    const match = /!\[image\]\(([^)]+)\)/.exec(result.comment.markdown)
    expect(match).not.toBeNull()
    const written = await readFile(join(wsDir, match![1]!), 'utf-8')
    expect(written.length).toBeGreaterThan(0)
  })

  it('keeps several images from one album in a single comment', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const { client } = mockClient()
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const attachment = (name: string) => ({
      filename: name,
      mediaType: 'image/jpeg',
      sizeBytes: jpeg.byteLength,
      contentBase64: jpeg.toString('base64'),
    })

    const result = await ingestTelegramOwnerMessage(host(), {
      connectorId: 'telegram',
      userId: '42',
      text: 'Two timeframes',
      attachments: [attachment('h4.jpg'), attachment('m15.jpg')],
    }, client)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.comment.markdown.match(/!\[image\]/g) ?? []).toHaveLength(2)
  })

  it('accepts an image with no caption at all', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const { client } = mockClient()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const result = await ingestTelegramOwnerMessage(host(), {
      connectorId: 'telegram',
      userId: '42',
      attachments: [{
        filename: 'only.png',
        mediaType: 'image/png',
        sizeBytes: png.byteLength,
        contentBase64: png.toString('base64'),
      }],
    }, client)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.comment.markdown).toContain('![image]')
  })

  it('ignores an attachment type it cannot render rather than failing the turn', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const { client } = mockClient()
    const result = await ingestTelegramOwnerMessage(host(), {
      connectorId: 'telegram',
      userId: '42',
      text: 'see attached',
      attachments: [{
        filename: 'notes.pdf',
        mediaType: 'application/pdf',
        sizeBytes: 4,
        contentBase64: Buffer.from('data').toString('base64'),
      }],
    }, client)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.comment.markdown).toBe('see attached')
  })

  it('leaves activity lifecycle to the dispatched turn', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const { client, sent } = mockClient()
    const result = await ingestTelegramOwnerMessage(host({
      conversation: () => ({
        replyToIssue: async () => ({ taskId: 'run-1', resumeId: 'resume-1' }),
      } as unknown as NonNullable<ReturnType<TelegramDeskChatHost['conversation']>>),
    }), {
      connectorId: 'telegram',
      userId: '42',
      text: 'What is the overnight risk?',
    }, client)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(sent).toEqual([])
  })

  it('stamps a scheduled fire as a comment', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const { client, sent } = mockClient()
    const comment = await stampTelegramDeskScheduledFire({
      host: host(),
      client,
      workspaceId: 'ws-a',
      issueId: created.issue.id,
      task: {
        taskId: 'run-1',
        resumeId: 'resume-desk-owner',
        wsId: 'ws-a',
        agent: 'pi',
        prompt: 'wake',
        startedAt: 1,
        status: 'done',
        finishedAt: 2,
        trigger: {
          kind: 'issue',
          workspaceId: 'ws-a',
          issueId: created.issue.id,
          metadata: { kind: 'connector-cron-issue', connectorId: 'telegram' },
        },
      },
      assistantText: 'Markets are quiet. [[no-reply]] no send.',
    })
    expect(comment?.markdown).toContain('[[no-reply]]')
    expect(comment?.id).toBe('comment-fire-run-1')
    expect(sent).toEqual([]) // Persistence is independent of execution-owned delivery.
    if (!comment) return
    expect(shouldProjectDeskComment(created.issue, comment, {
      triggerMetadata: { kind: 'connector-cron-issue', connectorId: 'telegram' },
    })).toBe(true)
  })

  it('does not publish partial assistant text from a failed scheduled fire', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const comment = await stampTelegramDeskScheduledFire({
      host: host(),
      workspaceId: 'ws-a',
      issueId: created.issue.id,
      task: {
        taskId: 'run-failed',
        resumeId: 'resume-desk-owner',
        wsId: 'ws-a',
        agent: 'pi',
        prompt: 'wake',
        startedAt: 1,
        status: 'failed',
        finishedAt: 2,
      },
      assistantText: 'Partial answer before the runtime failed.',
    })

    expect(comment).toBeNull()
  })

  it('does not consume connector control syntax without trigger metadata', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const comment = await stampTelegramDeskScheduledFire({
      host: host(),
      workspaceId: 'ws-a',
      issueId: created.issue.id,
      task: {
        taskId: 'run-unmarked',
        resumeId: 'resume-desk-owner',
        wsId: 'ws-a',
        agent: 'pi',
        prompt: 'wake',
        startedAt: 1,
        status: 'done',
        finishedAt: 2,
        trigger: { kind: 'issue', workspaceId: 'ws-a', issueId: created.issue.id },
      },
      assistantText: 'We discussed [[no-reply]] syntax.',
    })

    expect(comment).toBeNull()
  })

  it('quotes stacked inbound DMs as one comment', () => {
    expect(formatTelegramInboundStack(['one'])).toBe('one')
    expect(formatTelegramInboundStack([
      '那个事情我想了想你再改改',
      '算了不用改了,就这样吧',
    ])).toBe([
      '> 那个事情我想了想你再改改',
      '> 算了不用改了,就这样吧',
    ].join('\n'))
    expect(telegramDeskHasRunningWork([
      {
        status: 'running',
        inquiry: {
          subject: { kind: 'issue', workspaceId: 'ws-a', issueId: 'telegram-phone-desk', relation: 'owner' },
          question: 'hi',
          resolution: { mode: 'exact' },
        },
      },
    ], { wsId: 'ws-a', issue: { id: 'telegram-phone-desk' } })).toBe(true)
    expect(telegramDeskHasRunningWork([
      { status: 'done', trigger: { kind: 'issue', workspaceId: 'ws-a', issueId: 'telegram-phone-desk' } },
    ], { wsId: 'ws-a', issue: { id: 'telegram-phone-desk' } })).toBe(false)
  })

  it('records stacked inbound DMs as one human comment', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const { client } = mockClient()
    const messages = [
      { connectorId: 'telegram', eventId: '101', userId: '42', text: '那个事情我想了想你再改改' },
      { connectorId: 'telegram', eventId: '102', userId: '42', text: '算了不用改了,就这样吧' },
    ]
    const result = await ingestTelegramOwnerMessages(host(), messages, client)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.comment.markdown).toBe([
      '> 那个事情我想了想你再改改',
      '> 算了不用改了,就这样吧',
    ].join('\n'))
    const replayed = await ingestTelegramOwnerMessages(host(), messages, client)
    expect(replayed.ok && replayed.comment.id).toBe(result.comment.id)
    const comments = await readIssueComments(wsDir, created.ok ? created.issue.id : 'telegram-phone-desk')
    expect(comments.ok && comments.comments).toHaveLength(1)
  })

  it('returns inbound when no live desk exists yet', async () => {
    const returned: string[] = []
    const client = {
      claimInbound: async () => ({ claimId: 'claim-1', items: [{ queueId: 'in-1', eventId: '1', connectorId: 'telegram', userId: '42', text: 'queued' }] }),
      releaseInbound: async (_claimId: string, itemIds: string[]) => { returned.push(...itemIds) },
      ackInbound: async () => undefined,
    } as unknown as ConnectorClient

    await pullTelegramDeskInbound(host(), client)
    expect(returned).toEqual(['in-1'])

    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    returned.length = 0
    await pullTelegramDeskInbound(host(), client)
    expect(returned).toEqual([])
  })

  it('returns inbound for a generating desk so another connector can still flush', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)
    const returned: string[] = []
    const client = {
      claimInbound: async () => ({ claimId: 'claim-1', items: [{ queueId: 'in-1', eventId: '1', connectorId: 'telegram', userId: '42', text: 'later' }] }),
      releaseInbound: async (_claimId: string, itemIds: string[]) => { returned.push(...itemIds) },
      ackInbound: async () => undefined,
    } as unknown as ConnectorClient

    await pullTelegramDeskInbound(host({ deskGenerating: () => true }), client)
    expect(returned).toEqual(['in-1'])

    returned.length = 0
    await pullTelegramDeskInbound(host({ deskGenerating: () => false }), client)
    expect(returned).toEqual([])
  })

  it('does not overlap inbound drains when one poll is still running', async () => {
    const created = await createTelegramConnectorDesk(
      { id: 'ws-a', dir: wsDir },
      [{ id: 'ws-a', dir: wsDir }],
    )
    expect(created.ok).toBe(true)

    let active = 0
    let maxActive = 0
    let drains = 0
    const client = {
      claimInbound: async () => {
        drains += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        return { claimId: 'claim-empty', items: [] }
      },
    } as unknown as ConnectorClient

    const stop = startTelegramDeskInboundPoll(host(), { intervalMs: 2, client })
    await new Promise((resolve) => setTimeout(resolve, 55))
    stop()

    expect(drains).toBeGreaterThan(1)
    expect(maxActive).toBe(1)
  })
})
