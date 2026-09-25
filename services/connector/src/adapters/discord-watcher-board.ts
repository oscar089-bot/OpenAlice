/**
 * Persistent Discord watcher board.
 *
 * One Discord message per live watcher, edited in place on every sync. This is
 * the Discord analogue of Vibe-Trading's `Watcher Board Live Card`: the operator
 * opens their private app DM and sees every armed watcher's price, trigger bar,
 * and liveness without typing a command.
 *
 * Design constraints that shape this module:
 * - The board is OWNED BY STATE, not by the adapter. Message ids are persisted
 *   through `updateSettings` so a Connector Service restart re-adopts the same
 *   messages instead of spamming a second copy.
 * - Rendering is delegated to `@traderalice/connector-protocol`, so Alice and
 *   Discord cannot disagree about what a watcher's progress means.
 * - A card is a plain message, never a bot-reply: it is delivered to the linked
 *   owner only, exactly like Inbox notifications.
 */

import type { WatcherBoardItem, WatcherBoardSync } from '@traderalice/connector-protocol'
import { renderWatcherBoardCard } from '@traderalice/connector-protocol'
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import type { Client, Message, ButtonInteraction } from 'discord.js'
import type { DiscordBoardState } from './discord-board-store.js'

/** Discord's 2000-char cap, kept well below it so an edit never fails the send. */
const MAX_CARD_CHARS = 1900

/** Cap persisted ids so a long-lived install cannot grow the state file
 *  unbounded. Cards beyond this are re-created rather than adopted. */
const MAX_TRACKED_CARDS = 80

/** Button custom_id prefixes. The adapter routes any interaction starting with
 *  one of these back into the board, which is what keeps the buttons working
 *  across a restart — a collector-based view would have timed out. */
export const WATCHER_BOARD_TOGGLE_PREFIX = 'watcher-board-toggle:'
export const WATCHER_BOARD_DELETE_PREFIX = 'watcher-board-delete:'

export interface WatcherBoardHost {
  client(): Client | undefined
  ownerUserId(): string | undefined
  /** Dedicated board channel, when configured.
   *
   *  A private DM is the default because it always exists, but it interleaves
   *  with Inbox notifications. A dedicated channel keeps the persistent cards
   *  in one scrollable place, which is how Vibe-Trading's board works. When
   *  unset the board falls back to the DM, so this is additive. */
  boardChannelId(): string | undefined
  /** Persist message ids AND expanded state, so a restart adopts both. */
  persistState(state: DiscordBoardState): Promise<void>
  /** Last known state, loaded at adapter start. */
  knownState(): DiscordBoardState
  /** Ask Alice to delete a watcher. The connector cannot mutate watch state
   *  itself — Alice owns it — so this round-trips through the action queue. */
  requestDelete(input: { watcherId: string; workspaceId: string }): Promise<{ ok: boolean; message: string }>
  /** True when this Discord user may manage cards (the linked owner). */
  canManage(userId: string): boolean
}

function chunk(text: string): string {
  if (text.length <= MAX_CARD_CHARS) return text
  return `${text.slice(0, MAX_CARD_CHARS - 1).trimEnd()}\u2026`
}

/**
 * The sendable surface the board needs: a DM or a text channel.
 *
 * Both expose `send` and `messages.fetch`, so the board never branches on which
 * one it got. That is what lets a dedicated channel be added without forking
 * every send path.
 */
type BoardTarget = {
  send(content: string, options?: { components?: unknown[] }): Promise<Message>
  messages: { fetch(id: string): Promise<Message> }
}

export class DiscordWatcherBoard {
  private messages = new Map<string, Message>()
  private pendingAdoption = new Map<string, string>()
  /** watcherId → expanded. Persisted, so a restart keeps a card open. */
  private expanded = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private latest: WatcherBoardSync | null = null
  private frame = 0
  private syncing = false
  /**
   * Cached send target. Without this, a 5s pulse re-resolved the channel (a
   * `channels.fetch` plus a `createDM`) on every tick, which is a needless
   * gateway round-trip per card per tick.
   */
  private target: BoardTarget | null = null
  private targetClient: Client | undefined
  private targetChannelId: string | undefined

  constructor(private readonly host: WatcherBoardHost) {
    const state = host.knownState()
    for (const [watcherId, messageId] of Object.entries(state.messages)) {
      if (watcherId && messageId) {
        // A placeholder: the real Message is fetched lazily on first sync so a
        // restart costs no gateway calls until there is actually a board.
        this.pendingAdoption.set(watcherId, messageId)
      }
    }
    for (const [watcherId, isExpanded] of Object.entries(state.expanded)) {
      if (watcherId && isExpanded) this.expanded.add(watcherId)
    }
  }

  /** Begin the local pulse timer. Idempotent. */
  start(): void {
    if (this.timer) return
    const seconds = this.latest?.refreshSeconds ?? 5
    this.timer = setInterval(() => void this.tick(), Math.max(1, seconds) * 1000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    // A reconnect builds a new client, so the cached target must not survive.
    this.target = null
    this.targetClient = undefined
    this.targetChannelId = undefined
  }

  /**
   * Reconcile the chat against one complete board push. Idempotent: cards for
   * removed watchers are deleted, and an adopted message is edited rather than
   * re-sent.
   */
  async sync(board: WatcherBoardSync): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      const previousRefresh = this.latest?.refreshSeconds
      this.latest = board
      if (previousRefresh !== board.refreshSeconds) {
        this.stop()
        this.start()
      } else {
        this.start()
      }
      await this.reconcile(board)
    } finally {
      this.syncing = false
    }
  }

  /** Timer body: re-render from the last push with a new pulse frame. */
  private async tick(): Promise<void> {
    const board = this.latest
    if (!board || this.syncing) return
    this.frame += 1
    await this.reconcile(board, { pulseOnly: true })
  }

  private async reconcile(board: WatcherBoardSync, options: { pulseOnly?: boolean } = {}): Promise<void> {
    const target = await this.resolveTarget()
    if (!target) return

    const activeIds = new Set(board.items.map((item) => item.watcherId))
    const removed: string[] = []

    for (const item of board.items) {
      const isExpanded = this.expanded.has(item.watcherId)
      const rendered = renderWatcherBoardCard(item, this.frame)
      // Expanded shows the full detail panel, collapsed the compact card. An
      // expanded card KEEPS its detail across pulse ticks: the operator opened
      // it to read, and collapsing it back under them would be hostile.
      const body = chunk(isExpanded ? rendered.detail : rendered.card)
      const components = this.buildComponents(item.watcherId, isExpanded) as never
      const existing = await this.messageFor(item.watcherId, target)
      if (existing) {
        if (existing.content !== body) {
          await existing.edit({ content: body, components }).catch(() => undefined)
        }
        continue
      }
      const sent = await target.send(body, { components }).catch(() => undefined)
      if (sent) this.messages.set(item.watcherId, sent)
    }

    for (const [watcherId, message] of this.messages) {
      if (activeIds.has(watcherId)) continue
      removed.push(watcherId)
      await message.delete().catch(() => undefined)
    }
    for (const watcherId of removed) {
      this.messages.delete(watcherId)
      this.expanded.delete(watcherId)
    }
    for (const watcherId of [...this.pendingAdoption.keys()]) {
      if (!activeIds.has(watcherId)) this.pendingAdoption.delete(watcherId)
    }

    // Persist the live map only when a membership change happened, so the
    // pulse timer never writes state 12 times a minute.
    if (!options.pulseOnly) await this.persist()
    else if (removed.length > 0) await this.persist()
  }

  /**
   * Where cards live: the dedicated board channel when configured, otherwise
   * the owner's DM.
   *
   * The DM is the fallback because it always exists. A board that silently
   * vanished when a channel was unset or deleted would be worse than one that
   * shares scroll with Inbox notifications.
   */
  private async resolveTarget(): Promise<BoardTarget | null> {
    const client = this.host.client()
    if (!client?.isReady()) return null
    const channelId = this.host.boardChannelId()
    // Reuse unless the client or the configured channel changed. The channel id
    // is part of the key because an operator can point the board elsewhere
    // without restarting the adapter.
    if (this.target && this.targetClient === client && this.targetChannelId === channelId) {
      return this.target
    }
    let resolved: BoardTarget | null = null
    if (channelId) {
      try {
        const channel = await client.channels.fetch(channelId)
        if (channel && channel.isTextBased() && 'send' in channel) {
          resolved = channel as unknown as BoardTarget
        }
      } catch {
        // A stale channel id must not kill the board; fall through to the DM.
      }
    }
    if (!resolved) {
      const ownerId = this.host.ownerUserId()
      if (!ownerId) return null
      const user = await client.users.fetch(ownerId)
      resolved = await user.createDM() as unknown as BoardTarget
    }
    this.target = resolved
    this.targetClient = client
    this.targetChannelId = channelId
    return resolved
  }

  /** True when this custom_id belongs to the board. */
  static owns(customId: string): boolean {
    return customId.startsWith(WATCHER_BOARD_TOGGLE_PREFIX)
      || customId.startsWith(WATCHER_BOARD_DELETE_PREFIX)
  }

  /**
   * The Details/Delete row attached to every card.
   *
   * Details toggles the same message between the compact card and the full
   * panel; Delete asks Alice to remove the watcher and drops the card. Both are
   * non-destructive to the transport, so a mis-tap is recoverable except for the
   * delete, which is why delete is the danger-styled one.
   */
  buildComponents(watcherId: string, isExpanded: boolean): ActionRowBuilder<ButtonBuilder>[] {
    const toggle = new ButtonBuilder()
      .setCustomId(`${WATCHER_BOARD_TOGGLE_PREFIX}${watcherId}:${isExpanded ? 'collapse' : 'expand'}`)
      .setLabel(isExpanded ? 'Collapse' : 'Details')
      .setEmoji(isExpanded ? '\uD83D\uDD3C' : '\uD83D\uDD0E')
      .setStyle(ButtonStyle.Secondary)
    const remove = new ButtonBuilder()
      .setCustomId(`${WATCHER_BOARD_DELETE_PREFIX}${watcherId}`)
      .setLabel('Delete')
      .setEmoji('\uD83D\uDDD1\uFE0F')
      .setStyle(ButtonStyle.Danger)
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(toggle, remove)]
  }

  /**
   * Handle one button press. Returns false when the id is not ours, so the
   * adapter can leave unrelated interactions alone.
   *
   * Routed by custom_id rather than by a collector, because a collector's view
   * dies with the process and the cards outlive it.
   */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const { customId } = interaction
    const isToggle = customId.startsWith(WATCHER_BOARD_TOGGLE_PREFIX)
    const isDelete = customId.startsWith(WATCHER_BOARD_DELETE_PREFIX)
    if (!isToggle && !isDelete) return false
    if (!this.host.canManage(interaction.user.id)) {
      await interaction.reply({ content: 'You are not allowed to manage this watcher.', ephemeral: true }).catch(() => undefined)
      return true
    }
    const rest = customId.slice((isToggle ? WATCHER_BOARD_TOGGLE_PREFIX : WATCHER_BOARD_DELETE_PREFIX).length)
    const watcherId = isToggle ? (rest.split(':')[0] ?? '') : rest
    if (!watcherId) return true

    if (isToggle) {
      const isExpanded = !this.expanded.has(watcherId)
      if (isExpanded) this.expanded.add(watcherId)
      else this.expanded.delete(watcherId)
      const item = this.latest?.items.find((entry) => entry.watcherId === watcherId)
      if (item) {
        const rendered = renderWatcherBoardCard(item, this.frame)
        await interaction.update({
          content: chunk(isExpanded ? rendered.detail : rendered.card),
          components: this.buildComponents(watcherId, isExpanded) as never,
        }).catch(() => undefined)
      }
      await this.persist()
      await interaction.followUp({
        content: `${isExpanded ? 'Expanded' : 'Collapsed'} watcher \`${watcherId}\`.`,
        ephemeral: true,
      }).catch(() => undefined)
      return true
    }

    const result = await this.host.requestDelete({
      watcherId,
      workspaceId: this.latest?.items.find((entry) => entry.watcherId === watcherId)?.workspaceId ?? '',
    }).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
    if (!result.ok) {
      await interaction.reply({
        content: `Could not delete watcher \`${watcherId}\`: ${chunk(result.message)}`,
        ephemeral: true,
      }).catch(() => undefined)
      return true
    }
    // The card is NOT removed here. Alice has not confirmed the removal yet, and
    // deleting optimistically would make a refused delete indistinguishable from
    // a successful one. The next board push drops the card once it is really gone.
    await interaction.reply({
      content: `Delete requested for watcher \`${watcherId}\`. The card disappears once Alice confirms.`,
      ephemeral: true,
    }).catch(() => undefined)
    return true
  }

  private async messageFor(watcherId: string, target: BoardTarget): Promise<Message | null> {
    const known = this.messages.get(watcherId)
    if (known) return known
    const pendingId = this.pendingAdoption.get(watcherId)
    if (!pendingId) return null
    try {
      const fetched = await target.messages.fetch(pendingId)
      this.messages.set(watcherId, fetched)
      this.pendingAdoption.delete(watcherId)
      return fetched
    } catch {
      // The message was deleted out-of-band (operator cleanup). Drop the stale
      // id and let the caller post a fresh card.
      this.pendingAdoption.delete(watcherId)
      return null
    }
  }

  private async persist(): Promise<void> {
    const messages: Record<string, string> = {}
    for (const [watcherId, message] of [...this.messages.entries()].slice(0, MAX_TRACKED_CARDS)) {
      messages[watcherId] = message.id
    }
    const expanded: Record<string, boolean> = {}
    for (const watcherId of this.expanded) expanded[watcherId] = true
    await this.host.persistState({ messages, expanded }).catch(() => undefined)
  }
}
