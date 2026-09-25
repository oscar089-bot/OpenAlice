import { beforeEach, describe, expect, it, vi } from 'vitest'

// The board owns transport behaviour (target resolution, buttons, persisted
// expand state), not rendering. The renderer is fully covered by the
// connector-protocol suite, so it is stubbed here to keep these assertions
// focused on the Discord surface.
vi.mock('@traderalice/connector-protocol', () => ({
  renderWatcherBoardCard: (item: { watcherId: string }, frame: number) => ({
    watcherId: item.watcherId,
    card: `card:${item.watcherId}:${frame}`,
    detail: `detail:${item.watcherId}:${frame}`,
  }),
}))

import type { Mock } from 'vitest'
import type { WatcherBoardSync } from '@traderalice/connector-protocol'
import {
  DiscordWatcherBoard,
  WATCHER_BOARD_DELETE_PREFIX,
  WATCHER_BOARD_TOGGLE_PREFIX,
  type WatcherBoardHost,
} from './discord-watcher-board.js'

interface FakeMessage {
  id: string
  content: string
  edit: Mock
  delete: Mock
}

function makeMessage(id: string, content = ''): FakeMessage {
  const message: FakeMessage = {
    id,
    content,
    edit: vi.fn(async (payload: { content: string }) => {
      message.content = payload.content
      return message
    }),
    delete: vi.fn(async () => undefined),
  }
  return message
}

function makeTarget(prefix: string) {
  const sent: FakeMessage[] = []
  return {
    sent,
    isTextBased: () => true,
    send: vi.fn(async (content: string) => {
      const message = makeMessage(`${prefix}-${sent.length}`, content)
      sent.push(message)
      return message
    }),
    messages: { fetch: vi.fn(async (id: string) => makeMessage(id, 'adopted')) },
  }
}

const dm = makeTarget('dm')
const channel = makeTarget('channel')
const client = {
  isReady: () => true,
  channels: { fetch: vi.fn(async () => channel) },
  users: { fetch: vi.fn(async () => ({ createDM: async () => dm })) },
}

function boardOf(ids: string[]): WatcherBoardSync {
  return {
    refreshSeconds: 5,
    items: ids.map((watcherId) => ({
      watcherId,
      workspaceId: `ws-${watcherId}`,
      title: watcherId,
      running: true,
      pollable: true,
      pollSeconds: 5,
      spec: {},
      state: {},
      nowIso: '2026-01-01T00:00:00.000Z',
    })),
  } as unknown as WatcherBoardSync
}

type PersistedState = {
  messages: { [watcherId: string]: string }
  expanded: { [watcherId: string]: boolean }
}

type HostOverrides = { [K in keyof WatcherBoardHost]?: WatcherBoardHost[K] }

function makeHost(overrides: HostOverrides = {}) {
  const persisted: PersistedState[] = []
  const host: WatcherBoardHost = {
    client: () => client as never,
    ownerUserId: () => 'owner-1',
    boardChannelId: () => undefined,
    knownState: () => ({ messages: {}, expanded: {} }),
    persistState: async (state) => { persisted.push(state) },
    requestDelete: async () => ({ ok: true, message: 'queued' }),
    canManage: (userId) => userId === 'owner-1',
    ...overrides,
  }
  return { host, persisted }
}

function makeInteraction(customId: string, userId = 'owner-1') {
  return {
    customId,
    user: { id: userId },
    update: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  }
}

function buttonRow(board: DiscordWatcherBoard, watcherId: string, expanded: boolean) {
  const row = board.buildComponents(watcherId, expanded)[0]
  const json = row.toJSON() as {
    components: { custom_id?: string; label?: string; style?: number }[]
  }
  return json.components
}

beforeEach(() => {
  for (const target of [dm, channel]) {
    target.sent.length = 0
    target.send.mockClear()
    target.messages.fetch.mockClear()
  }
  client.channels.fetch.mockClear()
  client.users.fetch.mockClear()
})

describe('DiscordWatcherBoard', () => {
  it('claims only its own custom ids', () => {
    expect(DiscordWatcherBoard.owns(`${WATCHER_BOARD_TOGGLE_PREFIX}w1:expand`)).toBe(true)
    expect(DiscordWatcherBoard.owns(`${WATCHER_BOARD_DELETE_PREFIX}w1`)).toBe(true)
    expect(DiscordWatcherBoard.owns('uta-approve:1')).toBe(false)
  })

  it('builds a Details/Delete row that flips to Collapse when expanded', () => {
    const { host } = makeHost()
    const board = new DiscordWatcherBoard(host)
    const collapsed = buttonRow(board, 'w1', false)
    expect(collapsed[0]).toMatchObject({
      custom_id: `${WATCHER_BOARD_TOGGLE_PREFIX}w1:expand`,
      label: 'Details',
      style: 2,
    })
    expect(collapsed[1]).toMatchObject({
      custom_id: `${WATCHER_BOARD_DELETE_PREFIX}w1`,
      label: 'Delete',
      style: 4,
    })
    const expanded = buttonRow(board, 'w1', true)
    expect(expanded[0]).toMatchObject({
      custom_id: `${WATCHER_BOARD_TOGGLE_PREFIX}w1:collapse`,
      label: 'Collapse',
    })
  })

  it('falls back to the owner DM when no board channel is configured', async () => {
    const { host } = makeHost()
    const board = new DiscordWatcherBoard(host)
    await board.sync(boardOf(['w1']))
    board.stop()
    expect(dm.send).toHaveBeenCalledTimes(1)
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('posts to the dedicated board channel when configured', async () => {
    const { host } = makeHost({ boardChannelId: () => 'chan-1' })
    const board = new DiscordWatcherBoard(host)
    await board.sync(boardOf(['w1']))
    board.stop()
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(dm.send).not.toHaveBeenCalled()
  })

  it('persists expansion and renders the detail panel after a restart', async () => {
    const { host, persisted } = makeHost()
    const board = new DiscordWatcherBoard(host)
    await board.sync(boardOf(['w1']))
    await board.handleButton(makeInteraction(`${WATCHER_BOARD_TOGGLE_PREFIX}w1:expand`) as never)
    board.stop()
    expect(persisted.at(-1)?.expanded).toEqual({ w1: true })

    const { host: restartedHost } = makeHost({
      knownState: () => ({ messages: {}, expanded: { w1: true } }),
    })
    const restarted = new DiscordWatcherBoard(restartedHost)
    await restarted.sync(boardOf(['w1']))
    restarted.stop()
    expect(dm.sent.at(-1)?.content).toBe('detail:w1:0')
  })

  it('asks Alice to delete and keeps the card until confirmation', async () => {
    const requestDelete = vi.fn(async () => ({ ok: true, message: 'queued' }))
    const { host } = makeHost({ requestDelete })
    const board = new DiscordWatcherBoard(host)
    await board.sync(boardOf(['w1']))
    const interaction = makeInteraction(`${WATCHER_BOARD_DELETE_PREFIX}w1`)
    await board.handleButton(interaction as never)
    board.stop()
    expect(requestDelete).toHaveBeenCalledWith({ watcherId: 'w1', workspaceId: 'ws-w1' })
    expect(interaction.reply).toHaveBeenCalled()
    expect(interaction.update).not.toHaveBeenCalled()
  })

  it('refuses a non-owner', async () => {
    const { host } = makeHost()
    const board = new DiscordWatcherBoard(host)
    await board.sync(boardOf(['w1']))
    const interaction = makeInteraction(`${WATCHER_BOARD_TOGGLE_PREFIX}w1:expand`, 'stranger')
    const handled = await board.handleButton(interaction as never)
    board.stop()
    expect(handled).toBe(true)
    expect(interaction.reply).toHaveBeenCalled()
    expect(interaction.update).not.toHaveBeenCalled()
  })

  it('ignores a foreign custom id', async () => {
    const { host } = makeHost()
    const board = new DiscordWatcherBoard(host)
    expect(await board.handleButton(makeInteraction('uta-approve:1') as never)).toBe(false)
  })
})
