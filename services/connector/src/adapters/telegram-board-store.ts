/**
 * Adapter-owned persistence for the Telegram watcher board.
 *
 * Transport state, NOT operator configuration. It deliberately does NOT go
 * through `context.updateSettings`: connector settings are a validated,
 * operator-facing record whose mutation path rejects undeclared keys, and a
 * board message id is neither declared nor something a human should edit.
 *
 * Same sealed, atomic store pattern as the Discord board and the connector work
 * queue, so the board survives a Connector Service restart and cannot leak into
 * the Settings UI or an unsealed backup.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { dataPath } from '@/core/paths.js'
import { isSealedEnvelope, seal, unseal } from '@/core/sealing.js'

const boardStateSchema = z.object({
  version: z.literal(1),
  /** The chat the board lives in. Persisted rather than re-read from connector
   *  settings so a restart edits the SAME chat the operator opened it in. */
  chatId: z.number().int().nullable().default(null),
  /** The single board message, or null when the board has never been opened. */
  messageId: z.number().int().positive().nullable().default(null),
  /** Which watcher the pager is showing. Persisted so a restart does not
   *  teleport the operator back to the first watcher. */
  index: z.number().int().min(0).default(0),
  /** watcherIds whose detail panel is open, so a restart keeps cards open. */
  expanded: z.array(z.string()).default([]),
})

type PersistedBoardState = z.infer<typeof boardStateSchema>

export interface TelegramBoardState {
  /** The chat the board lives in, or null when the board is closed/dormant. */
  chatId: number | null
  /** The one board message, or null when the board is closed/dormant. */
  messageId: number | null
  /** Which watcher the pager is showing. */
  index: number
  /** watcherIds whose detail panel is expanded. */
  expanded: string[]
}

/** Persisted path. Overridable so a spec can use a temp file. */
export function telegramBoardStatePath(): string {
  return dataPath('state', 'connector-telegram-board.json')
}

/** The dormant board: nothing opened, nothing to render, nothing to edit. */
const CLOSED_BOARD: TelegramBoardState = {
  chatId: null,
  messageId: null,
  index: 0,
  expanded: [],
}

/** Read the persisted board state. Missing or malformed => closed board. */
export async function loadTelegramBoardState(
  path: string = telegramBoardStatePath(),
): Promise<TelegramBoardState> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isSealedEnvelope(raw)) return CLOSED_BOARD
    const state = boardStateSchema.parse(await unseal(raw))
    return {
      chatId: state.chatId,
      messageId: state.messageId,
      index: state.index,
      expanded: state.expanded,
    }
  } catch {
    // A missing file is the normal first run; a corrupt one must not stop the
    // adapter from starting, it simply reopens closed.
    return CLOSED_BOARD
  }
}

/** Persist the board state atomically. */
export async function saveTelegramBoardState(
  state: TelegramBoardState,
  path: string = telegramBoardStatePath(),
): Promise<void> {
  const payload: PersistedBoardState = {
    version: 1,
    chatId: state.chatId,
    messageId: state.messageId,
    index: state.index,
    expanded: state.expanded,
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
