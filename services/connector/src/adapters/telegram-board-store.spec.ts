import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadTelegramBoardState, saveTelegramBoardState } from './telegram-board-store.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'telegram-board-'))
  path = join(dir, 'board.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const CLOSED = { chatId: null, messageId: null, index: 0, expanded: [] }

describe('telegram board store', () => {
  it('round-trips the chat, message id, pager index and expanded set', async () => {
    await saveTelegramBoardState({ chatId: 99, messageId: 4242, index: 2, expanded: ['w-1', 'w-3'] }, path)
    expect(await loadTelegramBoardState(path)).toEqual({
      chatId: 99,
      messageId: 4242,
      index: 2,
      expanded: ['w-1', 'w-3'],
    })
  })

  it('round-trips a closed board', async () => {
    await saveTelegramBoardState(CLOSED, path)
    expect(await loadTelegramBoardState(path)).toEqual(CLOSED)
  })

  it('treats a missing file as a closed board', async () => {
    // First run. The board must be dormant, not crash the adapter start.
    expect(await loadTelegramBoardState(join(dir, 'absent.json'))).toEqual(CLOSED)
  })

  it('treats a corrupt or unsealed file as a closed board', async () => {
    // A plain JSON object is NOT a sealed envelope, so it must not be trusted.
    await writeFile(path, JSON.stringify({ version: 1, messageId: 99 }), 'utf8')
    expect(await loadTelegramBoardState(path)).toEqual(CLOSED)
    await writeFile(path, 'not json at all', 'utf8')
    expect(await loadTelegramBoardState(path)).toEqual(CLOSED)
  })

  it('overwrites the previous state rather than merging', async () => {
    await saveTelegramBoardState({ chatId: 11, messageId: 1, index: 5, expanded: ['a'] }, path)
    await saveTelegramBoardState({ chatId: 22, messageId: 2, index: 0, expanded: [] }, path)
    expect(await loadTelegramBoardState(path))
      .toEqual({ chatId: 22, messageId: 2, index: 0, expanded: [] })
  })

  it('reads an invalid persisted message id as a closed board', async () => {
    // The write path is a plain store (same contract as Discord's), so load is
    // where the shape is enforced. An id that cannot be a Telegram message id
    // must close the board rather than point it at a garbage message.
    const { seal } = await import('@/core/sealing.js')
    await writeFile(
      path,
      JSON.stringify(await seal({ version: 1, messageId: -1, index: 0, expanded: [] })),
      'utf8',
    )
    expect(await loadTelegramBoardState(path)).toEqual(CLOSED)
  })

  it('fills in defaults for a file that predates the index and chat fields', async () => {
    const { seal } = await import('@/core/sealing.js')
    await writeFile(path, JSON.stringify(await seal({ version: 1, messageId: 7 })), 'utf8')
    // A file written before the board tracked its chat must not reset the
    // operator; it simply has no chat until the next open records one.
    expect(await loadTelegramBoardState(path))
      .toEqual({ chatId: null, messageId: 7, index: 0, expanded: [] })
  })
})
