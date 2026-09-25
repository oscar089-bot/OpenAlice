/**
 * Adapter-owned persistence for the Discord watcher board's message ids.
 *
 * This is transport state, NOT operator configuration. It deliberately does
 * NOT go through `context.updateSettings`: connector settings are a validated,
 * operator-facing record whose mutation path rejects undeclared keys, and a
 * board id map is neither declared nor something a human should edit.
 *
 * Instead it uses the same sealed, atomic store pattern as the connector work
 * queue, so message ids survive a Connector Service restart and cannot leak
 * into the Settings UI or an unsealed backup.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { dataPath } from '@/core/paths.js'
import { isSealedEnvelope, seal, unseal } from '@/core/sealing.js'

/** watcherId → Discord message id, plus per-watcher expanded state.
 *  Values are ids and booleans, never content. */
const boardStateSchema = z.object({
  version: z.literal(1),
  messages: z.record(z.string(), z.string()),
  // Absent on files written before the expand/collapse buttons existed; the
  // default keeps those readable instead of forcing a migration.
  expanded: z.record(z.string(), z.boolean()).default({}),
})

type BoardState = z.infer<typeof boardStateSchema>

/** The whole persisted board: message ids plus which cards are expanded. */
export interface DiscordBoardState {
  messages: Record<string, string>
  expanded: Record<string, boolean>
}

/** Persisted path. Overridable so a spec can use a temp file. */
export function discordBoardStatePath(): string {
  return dataPath('state', 'connector-discord-board.json')
}

/** Read the persisted board state. Missing or malformed ⇒ empty. */
export async function loadDiscordBoardState(
  path: string = discordBoardStatePath(),
): Promise<DiscordBoardState> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isSealedEnvelope(raw)) return { messages: {}, expanded: {} }
    const state = boardStateSchema.parse(await unseal(raw))
    return { messages: state.messages, expanded: state.expanded }
  } catch {
    // A missing file is the normal first run; a corrupt one must not stop the
    // adapter from starting, it simply re-posts cards.
    return { messages: {}, expanded: {} }
  }
}

/** Persist the board state atomically. */
export async function saveDiscordBoardState(
  state: DiscordBoardState,
  path: string = discordBoardStatePath(),
): Promise<void> {
  const payload: BoardState = { version: 1, messages: state.messages, expanded: state.expanded }
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