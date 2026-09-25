import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadDiscordBoardState, saveDiscordBoardState } from './discord-board-store.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-board-'))
  path = join(dir, 'board.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('discord board store', () => {
  it('round-trips message ids and expanded state', async () => {
    await saveDiscordBoardState({
      messages: { 'eurusd-watch': '111', 'btc-watch': '222' },
      expanded: { 'eurusd-watch': true },
    }, path)
    expect(await loadDiscordBoardState(path)).toEqual({
      messages: { 'eurusd-watch': '111', 'btc-watch': '222' },
      expanded: { 'eurusd-watch': true },
    })
  })

  it('treats a missing file as empty state', async () => {
    expect(await loadDiscordBoardState(join(dir, 'absent.json'))).toEqual({
      messages: {},
      expanded: {},
    })
  })

  it('treats a corrupt or unsealed file as empty state', async () => {
    // A plain JSON object is NOT a sealed envelope. A board must re-post rather
    // than fail the adapter start, so this is empty state and not a throw.
    await writeFile(path, JSON.stringify({ version: 1, messages: { a: '1' } }), 'utf8')
    expect(await loadDiscordBoardState(path)).toEqual({ messages: {}, expanded: {} })
    await writeFile(path, 'not json at all', 'utf8')
    expect(await loadDiscordBoardState(path)).toEqual({ messages: {}, expanded: {} })
  })

  it('overwrites the previous state rather than merging', async () => {
    await saveDiscordBoardState({ messages: { a: '1', b: '2' }, expanded: {} }, path)
    await saveDiscordBoardState({ messages: { a: '9' }, expanded: { a: true } }, path)
    expect(await loadDiscordBoardState(path)).toEqual({
      messages: { a: '9' },
      expanded: { a: true },
    })
  })

  // A file written before the expand/collapse buttons existed has no `expanded`
  // key. It must stay readable rather than force a migration or reset.
  it('reads a pre-buttons file that predates the expanded field', async () => {
    const { seal } = await import('@/core/sealing.js')
    await writeFile(
      path,
      JSON.stringify(await seal({ version: 1, messages: { a: '1' } })),
      'utf8',
    )
    expect(await loadDiscordBoardState(path)).toEqual({
      messages: { a: '1' },
      expanded: {},
    })
  })
})
