import { TelegramModelControls } from './telegram-model.js'
import { createHash } from 'node:crypto'
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import { autoRetry } from '@grammyjs/auto-retry'
import type {
  ConnectorAdapterConfig,
  ConnectorAdapterHealth,
  ConnectorArtifactDelivery,
  ConnectorUtaFailure,
  ConnectorUtaPresentation,
  InboxNotification,
  OwnerChatMessage,
  OwnerChatActivity,
  WatcherBoardItem,
  WatcherBoardSync,
} from '@traderalice/connector-protocol'
import {
  isInboxPushEnabled,
  renderTurnActivity,
  renderTurnActivityRich,
  TELEGRAM_CONNECTOR_DEFINITION,
} from '@traderalice/connector-protocol'
import { createInboxStore, type IInboxStore } from '@/core/inbox-store.js'
import type {
  ConnectorAdapter,
  ConnectorAdapterContext,
  ConnectorAdapterRegistration,
} from '../core/adapter.js'
import {
  DIRECT_CONNECTOR_PROXY_TRANSPORT,
  type ConnectorProxyTransport,
} from '../core/proxy.js'
import {
  AdapterHealthTracker,
  DEFAULT_CONNECTION_ATTEMPT_TIMEOUT_MS,
  DEFAULT_CONNECTION_RETRY_DELAY_MS,
  decodeConnectorAttachment,
  formatAdapterError,
  formatInboxNotification,
  formatPlainInboxNotification,
  superviseLongConnection,
} from './shared.js'
import { formatTelegramInboxMarkdownV2 } from './telegram-markdown-v2.js'
import {
  TELEGRAM_INBOX_PAGE_SIZE,
  advanceInboxSession,
  formatTelegramInboxPage,
  formatTelegramSettingsPage,
  parseTelegramControl,
  truncateTelegramText,
  transitionTelegramInbox,
  type TelegramInboxSession,
} from './telegram-controls.js'
import {
  formatTelegramUtaListPage,
  formatTelegramUtaLoadingPage,
  parseTelegramUtaControl,
  transitionTelegramUta,
  type TelegramUtaControl,
  type TelegramUtaSession,
} from './telegram-uta.js'
import { sendTelegramRichText } from './telegram-rich-text.js'
import {
  clampBoardIndex,
  formatTelegramWatcherBoard,
  parseTelegramWatchControl,
  toggleExpanded,
  type TelegramWatchControl,
  type TelegramWatcherBoardForm,
} from './telegram-watchers.js'
import {
  loadTelegramBoardState,
  saveTelegramBoardState,
  type TelegramBoardState,
} from './telegram-board-store.js'

const TELEGRAM_DRAFT_HEARTBEAT_MS = 20_000
const TELEGRAM_TYPING_HEARTBEAT_MS = 4_000
/**
 * Minimum gap between activity-only re-renders.
 *
 * The activity bar advances on this adapter's OWN frame rather than on Alice's
 * reported progress, because Alice's publisher is debounced at 1s and a tool
 * call routinely outlives it — a bar tied to reported progress would sit frozen
 * and read as a hang. A CONTENT change (a new tool, a new status) bypasses this
 * floor and renders immediately; only the between-change animation waits.
 * Telegram allows roughly one edit per second per chat, so ~0.8s is the
 * practical floor for a spinner that reads as continuous motion rather than a
 * once-a-second twitch.
 */
const TELEGRAM_ACTIVITY_RENDER_MS = 800
const TELEGRAM_RESUME_CHECK_INTERVAL_MS = 15_000
const TELEGRAM_RESUME_GAP_MS = 45_000
const MAX_FINISHED_DRAFTS = 128

interface TelegramDraftSession {
  draftId: number
  markdown?: string
  /** Live turn activity; when set it owns the slot instead of `markdown`. */
  activity?: OwnerChatActivity
  /** Advances on every activity render so the bar visibly moves. */
  frame: number
  /** Fingerprint of the last rendered activity, to detect real changes. */
  lastActivityKey?: string
  refreshedAt?: number
  /** Last time a `typing` action was sent. Throttled separately from renders,
   *  because the action outlives one animation frame and re-sending it every
   *  tick would spend the per-chat rate budget the frames themselves need. */
  lastTypingAt?: number
  typingFallback: boolean
  stopped: boolean
  pending: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}

function createDraftSession(conversationId: string): TelegramDraftSession {
  return {
    draftId: telegramDraftId(conversationId),
    frame: 0,
    typingFallback: false,
    stopped: false,
    pending: Promise.resolve(),
  }
}

export class TelegramConnectorAdapter implements ConnectorAdapter {
  readonly id = 'telegram'
  private readonly tracker = new AdapterHealthTracker(this.id)
  private readonly attemptTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly resumeCheckIntervalMs: number
  private readonly resumeGapMs: number
  private bot?: Bot
  private sessionReady = false
  private ownerUserId?: string
  private chatId?: string
  private inboxPush = true
  private inboxStore?: IInboxStore
  private readonly inboxSessions = new Map<string, TelegramInboxSession>()
  private readonly utaSessions = new Map<string, TelegramUtaSession>()
  private readonly utaPending = new Map<string, { chatId: number; messageId: number; session: TelegramUtaSession }>()
  private readonly drafts = new Map<string, TelegramDraftSession>()
  private readonly finishedDrafts = new Set<string>()
  private stopped = true
  private loop?: Promise<void>
  private abort?: AbortController
  private token?: string
  private adapterContext?: ConnectorAdapterContext
  private readonly proxy: ConnectorProxyTransport
  /**
   * The on-demand watcher board.
   *
   * Unlike Discord this board is DORMANT until the operator runs /watchers, and
   * it is a SINGLE message the pager edits in place. `messageId === null` means
   * closed: no edits, no chatter, nothing in the chat at all.
   */
  private boardChatId: number | null = null
  private boardMessageId: number | null = null
  private boardIndex = 0
  private boardExpanded = new Set<string>()
  /** Last Alice push, re-rendered on every board refresh. */
  private boardItems: WatcherBoardItem[] = []
  private boardRefreshSeconds = 5
  /** Advances per render so the pulse bar visibly moves between pushes. */
  private boardFrame = 0
  private boardStatePath?: string

  constructor(options: {
    attemptTimeoutMs?: number
    reconnectDelayMs?: number
    resumeCheckIntervalMs?: number
    resumeGapMs?: number
    startupTimeoutMs?: number
    inboxStore?: IInboxStore
    proxy?: ConnectorProxyTransport
    boardStatePath?: string
  } = {}) {
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? options.startupTimeoutMs ?? DEFAULT_CONNECTION_ATTEMPT_TIMEOUT_MS
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_CONNECTION_RETRY_DELAY_MS
    this.resumeCheckIntervalMs = options.resumeCheckIntervalMs ?? TELEGRAM_RESUME_CHECK_INTERVAL_MS
    this.resumeGapMs = options.resumeGapMs ?? TELEGRAM_RESUME_GAP_MS
    this.inboxStore = options.inboxStore
    this.proxy = options.proxy ?? DIRECT_CONNECTOR_PROXY_TRANSPORT
    if (options.boardStatePath) this.boardStatePath = options.boardStatePath
  }

  async start(config: ConnectorAdapterConfig, context: ConnectorAdapterContext): Promise<void> {
    let token: string
    try {
      token = requiredString(config, 'botToken')
    } catch (error) {
      this.tracker.degraded(error)
      throw error
    }
    this.ownerUserId = optionalString(config, 'ownerUserId')
    this.chatId = optionalString(config, 'chatId')
    this.inboxPush = isInboxPushEnabled(config.settings)
    this.token = token
    this.adapterContext = context
    // Adopt a board from a previous run, but send nothing: the board only ever
    // becomes visible when the operator runs /watchers. A restart therefore
    // resumes an open board in place instead of posting a second copy.
    const boardState = await loadTelegramBoardState(this.boardStatePath)
    this.boardChatId = boardState.chatId
    this.boardMessageId = boardState.messageId
    this.boardIndex = boardState.index
    this.boardExpanded = new Set(boardState.expanded)
    this.registerCommands(context)
    this.stopped = false
    this.abort = new AbortController()
    this.tracker.connecting('Connecting to Telegram.')
    this.loop = superviseLongConnection({
      label: 'telegram',
      isStopped: () => this.stopped,
      isSessionHealthy: () => {
        const status = this.tracker.get().status
        return status === 'healthy' || status === 'awaiting_link'
      },
      runSession: () => this.runSession(),
      disconnect: () => this.disconnectSession(),
      onFailure: (error) => {
        this.sessionReady = false
        this.tracker.degraded(error)
        console.warn('[connector] Telegram session failed:', formatAdapterError(error))
      },
      onAttempt: () => this.tracker.attempt(),
      onRetryScheduled: (delayMs, failures) => this.tracker.retryScheduled(delayMs, failures),
      delay: (ms) => this.delay(ms),
      reconnectDelayMs: this.reconnectDelayMs,
    }).catch((error) => {
      if (!this.stopped) {
        this.tracker.degraded(error)
        console.warn('[connector] Telegram supervisor stopped:', formatAdapterError(error))
      }
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopAllDrafts()
    this.finishedDrafts.clear()
    this.abort?.abort()
    await this.disconnectSession()
    await this.loop?.catch(() => undefined)
    this.loop = undefined
    this.tracker.stopped()
  }

  /**
   * The Telegram board is on-demand: it exists only because the operator ran
   * /watchers, so the Inbox-push toggle must not be able to freeze it.
   */
  boardIgnoresInboxPush(): boolean {
    return true
  }

  /**
   * Reconcile the on-demand watcher board against one Alice push.
   *
   * A closed board is a no-op: that is what keeps the board from ever
   * appearing in the chat uninvited. Nothing is queued or retried, because a
   * board is a live view rather than a durable message - a missed frame is
   * simply replaced by the next one.
   */
  async syncWatcherBoard(board: WatcherBoardSync): Promise<void> {
    this.boardItems = board.items
    this.boardRefreshSeconds = board.refreshSeconds
    if (this.boardMessageId === null) return
    // Clamp so a watcher removed while the operator was viewing it does not
    // leave the pager pointing past the end of the list.
    this.boardIndex = clampBoardIndex(this.boardIndex, board.items.length)
    await this.renderBoard().catch(() => undefined)
  }

  /** Assemble the current board state into one sendable form. */
  private buildBoardForm(): TelegramWatcherBoardForm {
    return formatTelegramWatcherBoard({
      items: this.boardItems,
      index: this.boardIndex,
      expanded: this.boardExpanded,
      frame: this.boardFrame++,
      nowIso: new Date().toISOString(),
      refreshSeconds: this.boardRefreshSeconds,
    })
  }

  /** Render and edit the OPEN board in place. No-op when the board is closed. */
  private async renderBoard(): Promise<void> {
    if (this.boardMessageId === null || this.boardChatId === null || !this.bot) return
    const form = this.buildBoardForm()
    this.boardIndex = form.index
    const markup = toInlineKeyboard(form.actions)
    await this.bot.api.editMessageText(
      this.boardChatId,
      this.boardMessageId,
      form.html,
      { parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) },
    )
  }

  /**
   * Open the board, or re-adopt an already-open one.
   *
   * This and renderBoard are the ONLY paths that touch a board message, which
   * is what makes the board on-demand: nothing is ever posted until the
   * operator runs /watchers. Re-adopting edits the existing message instead of
   * sending a second one, so the chat never accumulates stale cards.
   */
  private async openBoard(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id
    if (!chatId) return
    const form = this.buildBoardForm()
    this.boardIndex = form.index
    const markup = toInlineKeyboard(form.actions)
    const options = {
      parse_mode: 'HTML' as const,
      ...(markup ? { reply_markup: markup } : {}),
    }
    if (this.boardMessageId !== null && this.boardChatId !== null) {
      try {
        await ctx.api.editMessageText(this.boardChatId, this.boardMessageId, form.html, options)
        return
      } catch (error) {
        // `message is not modified` means the board ALREADY shows exactly this.
        // That is success, not failure — the operator asked for a board that is
        // on screen. Rethrowing here is what made `/watchers` appear to do
        // nothing whenever the live 5s tick had already drawn the current state.
        if (isTelegramMessageNotModified(error)) return
        // The operator deleted the board out-of-band (or Telegram discarded the
        // id). Posting a fresh one is the honest recovery — doing nothing would
        // look like a broken command.
        if (!isTelegramMessageGone(error)) throw error
        this.boardMessageId = null
        this.boardChatId = null
      }
    }

    const sent = await ctx.reply(form.html, options)
    this.boardChatId = chatId
    this.boardMessageId = sent.message_id
    await this.persistBoard()
  }

  private async persistBoard(): Promise<void> {
    const state: TelegramBoardState = {
      chatId: this.boardChatId,
      messageId: this.boardMessageId,
      index: this.boardIndex,
      expanded: [...this.boardExpanded],
    }
    await saveTelegramBoardState(state, this.boardStatePath).catch(() => undefined)
  }

  /**
   * Handle one board button press.
   *
   * Every branch edits the SAME message, so the board never multiplies. Close
   * is the only destructive transport action, and Delete does NOT remove the
   * card optimistically: Alice owns watch state, so a refused delete must not
   * be indistinguishable from a successful one. The watcher drops off on a
   * later push once Alice has really removed it.
   */
  private async handleWatchControl(
    ctx: Context,
    context: ConnectorAdapterContext,
    control: TelegramWatchControl,
  ): Promise<void> {
    if (!this.isOwner(String(ctx.from?.id ?? ''))) {
      await ctx.answerCallbackQuery({ text: 'Only the linked owner can manage watchers.' })
      return
    }
    await ctx.answerCallbackQuery()

    if (control.kind === 'close') {
      const chatId = this.boardChatId
      const messageId = this.boardMessageId
      this.boardChatId = null
      this.boardMessageId = null
      this.boardIndex = 0
      this.boardExpanded.clear()
      await this.persistBoard()
      if (chatId !== null && messageId !== null) {
        await ctx.api.deleteMessage(chatId, messageId).catch(() => undefined)
      }
      return
    }

    const item = this.boardItems[clampBoardIndex(this.boardIndex, this.boardItems.length)]
    if (!item) {
      await ctx.editMessageText('No watchers armed. Arm one in OpenAlice, then send /watchers again.')
        .catch(() => undefined)
      return
    }

    if (control.kind === 'next' || control.kind === 'prev') {
      this.boardIndex = clampBoardIndex(
        this.boardIndex + (control.kind === 'next' ? 1 : -1),
        this.boardItems.length,
      )
      await this.renderBoard().catch(() => undefined)
      await this.persistBoard()
      return
    }

    if (control.kind === 'toggle') {
      this.boardExpanded = toggleExpanded(this.boardExpanded, item.watcherId)
      await this.renderBoard().catch(() => undefined)
      await this.persistBoard()
      return
    }

    const result = await context.enqueueWatchRequest({
      action: 'delete',
      workspaceId: item.workspaceId,
      watcherId: item.watcherId,
    }).then(() => ({ ok: true, message: 'accepted' })).catch((error) => ({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }))
    await ctx.answerCallbackQuery({
      text: result.ok
        ? `Delete requested for ${item.spec.pair || item.watcherId}. The card disappears once OpenAlice confirms.`
        : `Could not delete watcher: ${result.message}`,
      show_alert: !result.ok,
    }).catch(() => undefined)
  }

  async deliver(notification: InboxNotification): Promise<void> {
    if (!this.bot || !this.sessionReady) throw new Error('Telegram bot is not ready')
    if (!this.chatId) throw new Error('Telegram private chat is not linked')
    this.tracker.attempt()
    try {
      await sendTelegramRichText(
        this.bot.api,
        this.chatId,
        formatInboxNotification(notification),
        formatPlainInboxNotification(notification),
        formatTelegramInboxMarkdownV2(notification),
      )
      this.tracker.success(this.ownerUserId)
    } catch (error) {
      this.tracker.degraded(error)
      throw error
    }
  }

  async deliverArtifact(delivery: ConnectorArtifactDelivery): Promise<void> {
    return this.sendOwnerFile(delivery.attachment)
  }

  async sendOwnerFile(attachment: ConnectorArtifactDelivery['attachment'], presentation: import('../core/reply-directives.js').ReplyMedia = 'file'): Promise<void> {
    if (!this.bot || !this.sessionReady) throw new Error('Telegram bot is not ready')
    if (!this.chatId) throw new Error('Telegram private chat is not linked')
    this.tracker.attempt()
    try {
      const file = decodeConnectorAttachment(attachment)
      const input = new InputFile(file.content, file.filename)
      if (presentation === 'sticker') await this.bot.api.sendSticker(this.chatId, input)
      else if (presentation === 'image') await this.bot.api.sendPhoto(this.chatId, input)
      else await this.bot.api.sendDocument(this.chatId, input,
        { caption: truncateTelegramText(`Current file: ${file.filename}`, 200) })
      this.tracker.success(this.ownerUserId)
    } catch (error) {
      this.tracker.degraded(error)
      throw error
    }
  }

  async sendOwnerText(text: string): Promise<void> {
    if (!this.bot || !this.sessionReady) throw new Error('Telegram bot is not ready')
    if (!this.chatId) throw new Error('Telegram private chat is not linked')
    this.tracker.attempt()
    try {
      await sendTelegramRichText(this.bot.api, this.chatId, text)
      this.tracker.success(this.ownerUserId)
    } catch (error) {
      this.tracker.degraded(error)
      throw error
    }
  }

  async sendOwnerChat(message: OwnerChatMessage): Promise<void> {
    if (message.phase === 'accepted' || message.phase === 'progress') {
      this.tracker.attempt()
      try {
        if (message.phase === 'accepted') {
          await this.startDraft(message.conversationId, message.activity)
        } else if (message.activity) {
          await this.updateActivity(message.conversationId, message.activity)
        } else if (message.text) {
          await this.updateDraft(message.conversationId, message.text)
        }
        this.tracker.success(this.ownerUserId)
        return
      } catch (error) {
        this.tracker.degraded(error)
        throw error
      }
    }

    await this.finishDraft(message.conversationId)
    if (message.text) await this.sendOwnerText(message.text)
  }

  health(): ConnectorAdapterHealth {
    return this.tracker.get()
  }

  async presentUta(presentation: ConnectorUtaPresentation): Promise<void> {
    const pending = this.utaPending.get(presentation.requestId)
    const form = formatTelegramUtaListPage(presentation.review, presentation.result)
    const session: TelegramUtaSession = {
      accountIds: presentation.review.accounts.map((account) => account.id),
      review: presentation.review,
      result: presentation.result,
      view: { kind: 'list' },
    }
    if (!pending) {
      if (!this.chatId) throw new Error('Telegram private chat is not linked')
      await this.sendOwnerText(form.text)
      return
    }
    this.utaPending.delete(presentation.requestId)
    const sent = await this.editForm(pending.chatId, pending.messageId, form)
    if (sent) this.utaSessions.set(sessionKey(pending.chatId, sent), session)
  }

  async failUta(failure: ConnectorUtaFailure): Promise<void> {
    const pending = this.utaPending.get(failure.requestId)
    if (!pending) {
      await this.sendOwnerText(failure.message)
      return
    }
    this.utaPending.delete(failure.requestId)
    await this.editForm(pending.chatId, pending.messageId, {
      text: failure.message,
      actions: [],
    })
  }

  private async runSession(): Promise<void> {
    const token = this.token
    const context = this.adapterContext
    if (!token || !context) throw new Error('Telegram adapter is not armed')
    if (this.tracker.get().status === 'degraded') this.tracker.connecting('Reconnecting to Telegram.')
    // grammY's default HttpError hides the underlying cause, and a failing
    // setup call is retried until our readiness timer wins — which reads as a
    // generic 30s timeout. OPENALICE_TELEGRAM_DEBUG=1 restores the cause for
    // diagnosis without leaking it into ordinary logs.
    const telegramDebug = process.env['OPENALICE_TELEGRAM_DEBUG'] === '1'
    const bot = new Bot(token, {
      client: {
        ...(telegramDebug ? { sensitiveLogs: true } : {}),
        ...(this.proxy.nodeFetchAgent
          ? { baseFetchConfig: { agent: this.proxy.nodeFetchAgent } }
          : {}),
      },
    })
    this.bot = bot
    this.sessionReady = false
    this.attachBot(bot, context)

    let ready = false
    let resolveReady!: () => void
    const becameReady = new Promise<void>((resolve) => { resolveReady = resolve })
    const polling = bot.start({
      drop_pending_updates: true,
      onStart: () => {
        ready = true
        resolveReady()
        this.sessionReady = true
        if (this.ownerUserId && this.chatId) this.tracker.healthy(this.ownerUserId)
        else this.tracker.awaitingLink()
        // Menu publish is convenience only. Never put it on the session
        // critical path: a hang or 400 must not delay getUpdates.
        void withTimeout(
          () => publishTelegramCommands(bot),
          this.attemptTimeoutMs,
          `Telegram command menu publish exceeded ${this.attemptTimeoutMs}ms`,
        ).catch((error) => {
          console.warn('[connector] Telegram command menu was not published:', formatAdapterError(error))
        })
        bot.api.config.use(autoRetry())
      },
    })

    let attemptTimer: ReturnType<typeof setTimeout> | undefined
    const attemptExpired = new Promise<never>((_resolve, reject) => {
      attemptTimer = setTimeout(() => {
        reject(new Error(`Telegram polling session did not become ready within ${this.attemptTimeoutMs}ms`))
      }, this.attemptTimeoutMs)
      attemptTimer.unref?.()
    })
    try {
      await Promise.race([
        becameReady,
        polling.then(() => {
          if (!ready) throw new Error('Telegram polling ended before it became ready')
        }),
        attemptExpired,
      ])
    } catch (error) {
      await Promise.resolve(bot.stop()).catch(() => undefined)
      throw error
    } finally {
      if (attemptTimer) clearTimeout(attemptTimer)
    }
    await this.awaitPollingOrAbort(polling)
  }

  private async disconnectSession(): Promise<void> {
    this.sessionReady = false
    this.stopAllDrafts()
    const bot = this.bot
    this.bot = undefined
    await Promise.resolve(bot?.stop()).catch(() => undefined)
  }

  private readonly modelControls = new TelegramModelControls()

  private attachBot(bot: Bot, context: ConnectorAdapterContext): void {
    bot.command('model', async ctx => {
      if (ctx.chat.type !== 'private' || !this.isOwner(String(ctx.from?.id ?? ''))) return
      if (!context.sessionModel) { await ctx.reply('Model controls are unavailable. Update OpenAlice.'); return }
      await this.modelControls.open(ctx, context.sessionModel, typeof ctx.match === 'string' ? ctx.match.trim() || undefined : undefined)
    })
    bot.command('inbox', async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) return
      await this.presentInbox(ctx, context, { stack: [], scope: 'unread' }).catch(async (error) => {
        this.tracker.degraded(error)
        await ctx.reply('Could not load Inbox. Check OpenAlice logs.').catch(() => undefined)
      })
    })
    bot.command('settings', async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) return
      await this.presentSettings(ctx, context).catch(async (error) => {
        this.tracker.degraded(error)
        await ctx.reply('Could not open settings. Check OpenAlice logs.').catch(() => undefined)
      })
    })
    bot.command('uta', async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) return
      await this.presentUtaCommand(ctx, context).catch(async (error) => {
        this.tracker.degraded(error)
        await ctx.reply('Could not open UTA. Check OpenAlice logs.').catch(() => undefined)
      })
    })
    bot.command('watchers', async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) return
      if (!this.isOwner(String(ctx.from.id))) {
        await ctx.reply('This command is only available to the linked owner.')
        return
      }
      await this.openBoard(ctx).catch(async (error) => {
        this.tracker.degraded(error)
        await ctx.reply('Could not open the watcher board. Check OpenAlice logs.').catch(() => undefined)
      })
    })
    // Alias. Operators type the singular constantly, and an unregistered command
    // falls through to the owner-text handler as an ordinary message.
    bot.command('watcher', async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) return
      if (!this.isOwner(String(ctx.from.id))) {
        await ctx.reply('This command is only available to the linked owner.')
        return
      }
      await this.openBoard(ctx).catch(async (error) => {
        this.tracker.degraded(error)
        await ctx.reply('Could not open the watcher board. Check OpenAlice logs.').catch(() => undefined)
      })
    })
    bot.on('callback_query:data', async (ctx) => {
      await this.handleControl(ctx, context).catch(async (error) => {
        this.tracker.degraded(error)
        await ctx.answerCallbackQuery({ text: 'That control failed.' }).catch(() => undefined)
      })
    })

    for (const command of TELEGRAM_CONNECTOR_DEFINITION.commands) {
      if (command.name === 'model' || command.name === 'inbox' || command.name === 'settings' || command.name === 'uta' || command.name === 'watchers' || command.name === 'watcher') continue
      bot.command(command.name, async (ctx) => {
        if (ctx.chat.type !== 'private' || !ctx.from) return
        const handled = await context.commands.execute({
          connectorId: this.id,
          command: command.name,
          userId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          reply: async (message) => { await ctx.reply(message) },
        }).catch(async (error) => {
          this.tracker.degraded(error)
          await ctx.reply('Connector command failed. Check OpenAlice logs.').catch(() => undefined)
          return true
        })
        if (!handled) await ctx.reply('Unknown connector command.')
      })
    }
    bot.on('message:text', async (ctx) => {
      if (ctx.chat.type !== 'private' || !ctx.from) return
      const text = ctx.message.text.trim()
      if (!text || text.startsWith('/')) return
      if (!this.isOwner(String(ctx.from.id))) return
      try {
        await context.forwardOwnerText({
          text,
          userId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          eventId: String(ctx.message.message_id),
        })
      } catch (error) {
        this.tracker.degraded(error)
        await ctx.reply('OpenAlice could not accept this message. Check Connector Settings and logs.')
          .catch(() => undefined)
      }
    })
  }

  private async awaitPollingOrAbort(polling: Promise<void>): Promise<void> {
    const signal = this.abort?.signal
    if (!signal || signal.aborted) return
    let onAbort: (() => void) | undefined
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const sessionAbort = new AbortController()
    const resumed = waitForResumeGap({
      signal: sessionAbort.signal,
      intervalMs: this.resumeCheckIntervalMs,
      gapMs: this.resumeGapMs,
    }).then((detected) => {
      if (detected) throw new Error('Host resumed after sleep; reconnecting Telegram polling')
    })
    try {
      await Promise.race([polling, aborted, resumed])
    } finally {
      sessionAbort.abort()
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  private async delay(ms: number): Promise<void> {
    const signal = this.abort?.signal
    if (signal?.aborted) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      timer.unref?.()
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private registerCommands(context: ConnectorAdapterContext): void {
    context.commands.register('link', async ({ userId, chatId, reply }) => {
      if (this.ownerUserId && this.ownerUserId !== userId) {
        await reply('This connector is already linked to another account.')
        return
      }
      if (!chatId) throw new Error('Telegram private chat ID is missing')
      this.ownerUserId = userId
      this.chatId = chatId
      await context.updateSettings({ ownerUserId: userId, chatId })
      this.tracker.healthy(userId)
      await reply('Telegram is linked to this OpenAlice installation.')
    })
    context.commands.register('status', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      await reply(`OpenAlice Connector Service: ${context.getServiceStatus()}. Telegram: ${this.health().status}.`)
    })
    context.commands.register('test', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      const probeId = await context.sendTest(this.id)
      await reply(`Test notification sent. Probe: ${probeId}`)
    })
    context.commands.register('stop', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      if (!context.stopDeskRun) return reply('Stopping a reply is unavailable. Update OpenAlice.')
      const result = await context.stopDeskRun()
      await reply(result.stopped
        ? 'Stopping the Agent reply now.'
        : 'No Agent reply is running for this chat.')
    })
  }

  private async presentInbox(
    ctx: Context,
    _context: ConnectorAdapterContext,
    session: TelegramInboxSession,
    mode: 'reply' | 'edit' = 'reply',
  ): Promise<void> {
    if (!this.isOwner(String(ctx.from?.id ?? ''))) {
      if (mode === 'edit') await ctx.answerCallbackQuery({ text: 'Only the linked owner can use this.' })
      else await ctx.reply('This command is only available to the linked owner.')
      return
    }
    const scope = session.scope ?? 'unread'
    const page = await this.resolveInboxStore().read({
      ...(scope === 'unread' ? { unread: true } : {}),
      limit: TELEGRAM_INBOX_PAGE_SIZE,
      ...(session.before ? { before: session.before } : {}),
    })
    const nextSession: TelegramInboxSession = {
      stack: session.stack,
      scope,
      ...(session.before ? { before: session.before } : {}),
      entryIds: page.entries.map((entry) => entry.id),
    }
    const form = formatTelegramInboxPage({
      entries: page.entries,
      hasMore: page.hasMore,
      canGoNewer: session.stack.length > 0,
      scope,
    })
    const sent = await this.presentForm(ctx, form, mode)
    if (sent && ctx.chat) this.inboxSessions.set(sessionKey(ctx.chat.id, sent), nextSession)
  }

  private async presentUtaCommand(ctx: Context, context: ConnectorAdapterContext): Promise<void> {
    if (!this.isOwner(String(ctx.from?.id ?? ''))) {
      await ctx.reply('This command is only available to the linked owner.')
      return
    }
    const session: TelegramUtaSession = {
      accountIds: [],
      view: { kind: 'loading', reason: 'Asking OpenAlice for the current UTA review…' },
    }
    const form = formatTelegramUtaLoadingPage()
    const sent = await this.presentForm(ctx, form, 'reply')
    if (!sent || !ctx.chat) return
    try {
      const requestId = await context.enqueueUtaRequest({ action: 'review' })
      session.requestId = requestId
      this.utaSessions.set(sessionKey(ctx.chat.id, sent), session)
      this.utaPending.set(requestId, { chatId: ctx.chat.id, messageId: sent, session })
    } catch (error) {
      await this.editForm(ctx.chat.id, sent, {
        text: error instanceof Error ? error.message : 'Could not request the UTA review. Try again.',
        actions: [],
      })
    }
  }

  private async presentSettings(ctx: Context, _context: ConnectorAdapterContext, mode: 'reply' | 'edit' = 'reply'): Promise<void> {
    if (!this.isOwner(String(ctx.from?.id ?? ''))) {
      if (mode === 'edit') await ctx.answerCallbackQuery({ text: 'Only the linked owner can use this.' })
      else await ctx.reply('This command is only available to the linked owner.')
      return
    }
    await this.presentForm(ctx, formatTelegramSettingsPage(this.inboxPush), mode)
  }

  private async handleControl(ctx: Context, context: ConnectorAdapterContext): Promise<void> {
    const data = ctx.callbackQuery?.data
    if (!data) return
    const watchControl = parseTelegramWatchControl(data)
    if (watchControl) {
      await this.handleWatchControl(ctx, context, watchControl)
      return
    }
    if (data.startsWith('mdl:')) {
      if (ctx.chat?.type !== 'private' || !this.isOwner(String(ctx.from?.id ?? '')) || !context.sessionModel) {
        await ctx.answerCallbackQuery({ text: 'Only the linked owner can change settings.' }); return
      }
      await this.modelControls.handle(ctx, context.sessionModel); return
    }
    const utaControl = parseTelegramUtaControl(data)
    if (utaControl) {
      await this.handleUtaControl(ctx, context, utaControl)
      return
    }
    const control = parseTelegramControl(data)
    if (!control) {
      await ctx.answerCallbackQuery()
      return
    }
    const messageId = ctx.callbackQuery?.message?.message_id
    const key = ctx.chat && messageId ? sessionKey(ctx.chat.id, messageId) : undefined
    const current = key ? this.inboxSessions.get(key) : undefined
    const resolution = await transitionTelegramInbox(current, control, {
      isOwner: this.isOwner(String(ctx.from?.id ?? '')),
      getEntry: (id) => this.resolveInboxStore().get(id),
    })
    if (resolution.kind === 'forbidden') {
      await ctx.answerCallbackQuery({ text: 'Only the linked owner can use this.' })
      return
    }
    await ctx.answerCallbackQuery()
    if (resolution.kind === 'ignored') return
    if (resolution.kind === 'settings') {
      this.inboxPush = resolution.inboxPush
      await context.updateSettings({ inboxPush: resolution.inboxPush })
      await this.presentSettings(ctx, context, 'edit')
      return
    }
    if (resolution.kind === 'expired') {
      await ctx.editMessageText('This Inbox page expired. Send /inbox again.')
      return
    }
    if (resolution.kind === 'error') {
      await ctx.editMessageText(resolution.text)
      return
    }
    if (resolution.kind === 'page') {
      const scope = resolution.session.scope ?? 'unread'
      const page = await this.resolveInboxStore().read({
        ...(scope === 'unread' ? { unread: true } : {}),
        limit: TELEGRAM_INBOX_PAGE_SIZE,
        ...(resolution.session.before ? { before: resolution.session.before } : {}),
      })
      const next = advanceInboxSession(resolution.session, resolution.direction, page.entries.at(-1)?.id)
      await this.presentInbox(ctx, context, next, 'edit')
      return
    }
    if (resolution.kind === 'reload-inbox') {
      await this.presentInbox(ctx, context, resolution.session, 'edit')
      return
    }
    if (resolution.kind === 'request-artifact') {
      try {
        await context.enqueueArtifactRequest({
          entryId: resolution.entryId,
          docIndex: resolution.docIndex,
        })
      } catch (error) {
        await ctx.editMessageText(
          error instanceof Error ? error.message : 'Could not request that file. Try again.',
        )
        return
      }
      const sent = await this.presentForm(ctx, resolution.form, 'edit')
      if (sent && ctx.chat) this.inboxSessions.set(sessionKey(ctx.chat.id, sent), resolution.session)
      return
    }
    const sent = await this.presentForm(ctx, resolution.form, 'edit')
    if (sent && ctx.chat) this.inboxSessions.set(sessionKey(ctx.chat.id, sent), resolution.session)
  }

  private async handleUtaControl(
    ctx: Context,
    context: ConnectorAdapterContext,
    control: TelegramUtaControl,
  ): Promise<void> {
    const messageId = ctx.callbackQuery?.message?.message_id
    const key = ctx.chat && messageId ? sessionKey(ctx.chat.id, messageId) : undefined
    const current = key ? this.utaSessions.get(key) : undefined
    const resolution = transitionTelegramUta(current, control, {
      isOwner: this.isOwner(String(ctx.from?.id ?? '')),
    })
    if (resolution.kind === 'forbidden') {
      await ctx.answerCallbackQuery({ text: 'Only the linked owner can use this.' })
      return
    }
    await ctx.answerCallbackQuery()
    if (resolution.kind === 'ignored') return
    if (resolution.kind === 'expired') {
      await ctx.editMessageText('This UTA page expired. Send /uta again.')
      return
    }
    if (resolution.kind === 'enqueue') {
      try {
        const requestId = await context.enqueueUtaRequest({
          action: resolution.action,
          ...(resolution.utaId ? { utaId: resolution.utaId } : {}),
          ...(resolution.pendingHash ? { pendingHash: resolution.pendingHash } : {}),
        })
        const next = { ...resolution.session, requestId }
        const sent = await this.presentForm(ctx, resolution.form, 'edit')
        if (sent && ctx.chat) {
          this.utaSessions.set(sessionKey(ctx.chat.id, sent), next)
          this.utaPending.set(requestId, { chatId: ctx.chat.id, messageId: sent, session: next })
        }
      } catch (error) {
        await ctx.editMessageText(
          error instanceof Error ? error.message : 'Could not send that UTA request. Try again.',
        )
      }
      return
    }
    const sent = await this.presentForm(ctx, resolution.form, 'edit')
    if (sent && ctx.chat) this.utaSessions.set(sessionKey(ctx.chat.id, sent), resolution.session)
  }

  private async presentForm(
    ctx: Context,
    form: { text: string; actions: Array<Array<{ text: string; data: string }>> },
    mode: 'reply' | 'edit',
  ): Promise<number | undefined> {
    const markup = toInlineKeyboard(form.actions)
    if (mode === 'edit') {
      await ctx.editMessageText(form.text, markup ? { reply_markup: markup } : {})
      return ctx.callbackQuery?.message?.message_id
    }
    const sent = await ctx.reply(form.text, markup ? { reply_markup: markup } : {})
    return sent.message_id
  }

  private async editForm(
    chatId: number,
    messageId: number,
    form: { text: string; actions: Array<Array<{ text: string; data: string }>> },
  ): Promise<number | undefined> {
    if (!this.bot) throw new Error('Telegram bot is not ready')
    const markup = toInlineKeyboard(form.actions)
    await this.bot.api.editMessageText(chatId, messageId, form.text, markup ? { reply_markup: markup } : {})
    return messageId
  }

  private resolveInboxStore(): IInboxStore {
    return this.inboxStore ??= createInboxStore()
  }

  private isOwner(userId: string): boolean {
    return Boolean(this.ownerUserId && this.ownerUserId === userId)
  }

  async stopOwnerActivity(conversationId: string): Promise<void> {
    this.stopDraft(conversationId)
  }

  private async startDraft(conversationId: string, activity?: OwnerChatActivity): Promise<void> {
    if (this.finishedDrafts.has(conversationId)) return
    const current = this.drafts.get(conversationId)
    if (current) return // Alice's activity lease heartbeat must not erase draft text.
    this.stopDraft(conversationId)
    const session = createDraftSession(conversationId)
    // Seed the slot so the turn is visibly alive from the moment it starts.
    // The model's first token can take many seconds, and an empty slot in that
    // gap is indistinguishable from a stalled turn.
    session.activity = activity ?? { toolCalls: 0, toolFailures: 0 }
    session.lastActivityKey = JSON.stringify(session.activity)
    this.drafts.set(conversationId, session)
    try {
      await this.queueDraftRefresh(conversationId, session)
    } finally {
      this.armDraftHeartbeat(conversationId, session)
    }
  }

  private async updateDraft(conversationId: string, markdown: string): Promise<void> {
    if (this.finishedDrafts.has(conversationId)) return
    const session = this.drafts.get(conversationId) ?? createDraftSession(conversationId)
    this.drafts.set(conversationId, session)
    session.markdown = markdown
    session.activity = undefined
    session.lastActivityKey = undefined
    session.refreshedAt = undefined
    try {
      await this.queueDraftRefresh(conversationId, session)
    } finally {
      this.armDraftHeartbeat(conversationId, session)
    }
  }

  /**
   * Point the ephemeral slot at live turn activity.
   *
   * The slot is EDITED in place, never appended to — Alice reuses one message id
   * per turn, so this replaces whatever the slot showed before. That is what
   * makes the working indicator vanish when the real reply arrives: Telegram
   * drafts are transient by construction, so there is no cleanup step and no
   * leftover "Reading a file" message above the answer.
   *
   * An unchanged activity payload still re-arms the heartbeat rather than
   * returning early: a single tool call can outlive Alice's 1s progress
   * debounce, and the heartbeat is what keeps the bar moving through it.
   */
  private async updateActivity(conversationId: string, activity: OwnerChatActivity): Promise<void> {
    if (this.finishedDrafts.has(conversationId)) return
    const session = this.drafts.get(conversationId) ?? createDraftSession(conversationId)
    this.drafts.set(conversationId, session)
    const key = JSON.stringify(activity)
    if (session.lastActivityKey === key) {
      // Same text, same tool. Only the bar needs to advance, and the heartbeat
      // already owns that cadence — rendering here would spend an edit on a
      // frame the next tick would immediately supersede.
      this.armDraftHeartbeat(conversationId, session)
      return
    }
    session.lastActivityKey = key
    session.activity = activity
    session.markdown = undefined
    session.refreshedAt = undefined
    try {
      await this.queueDraftRefresh(conversationId, session)
    } finally {
      this.armDraftHeartbeat(conversationId, session)
    }
  }

  private queueDraftRefresh(conversationId: string, session: TelegramDraftSession): Promise<void> {
    const next = session.pending.catch(() => undefined).then(async () => {
      if (session.stopped || this.drafts.get(conversationId) !== session) return
      await this.refreshDraft(session)
    })
    session.pending = next
    return next
  }

  private async refreshDraft(session: TelegramDraftSession): Promise<void> {
    if (!this.bot || !this.sessionReady) throw new Error('Telegram bot is not ready')
    const chatId = telegramNumericChatId(this.chatId)
    const now = Date.now()
    // A text draft is content, not a durable working indicator. Keep typing alive
    // through tool calls and long pauses until the authoritative terminal event.
    // Telegram's typing action persists ~5s, so it is refreshed on its own
    // slower schedule rather than on every animation frame.
    if (session.lastTypingAt === undefined || now - session.lastTypingAt >= TELEGRAM_TYPING_HEARTBEAT_MS) {
      session.lastTypingAt = now
      await this.bot.api.sendChatAction(chatId, 'typing')
    }
    // Activity re-renders on a much shorter floor than narration: its whole job
    // is to look alive, and the spinner only moves when a frame is drawn.
    const floorMs = session.activity ? TELEGRAM_ACTIVITY_RENDER_MS : TELEGRAM_DRAFT_HEARTBEAT_MS
    if (session.refreshedAt !== undefined && now - session.refreshedAt < floorMs) return
    session.refreshedAt = now
    if (session.typingFallback) return
    // A live turn prefers the RICH card (blockquote + bold header), because the
    // tool-name meta reads as a separate column instead of trailing off the
    // headline. Narration renders in BOTH variants — between the header and the
    // meta — so the rich path does not lose it.
    const activity = session.activity
    // Advance the animation frame exactly once per render, whether or not the
    // rich path is the one that ends up being sent.
    const frame = activity ? session.frame++ : session.frame
    const richRender = activity ? renderTurnActivityRich(activity, frame) : undefined
    const plainRender = activity ? renderTurnActivity(activity, frame) : session.markdown
    try {
      const render = richRender ?? plainRender
      if (render) {
        await this.bot.api.sendRichMessageDraft(chatId, session.draftId, { markdown: render })
      } else {
        await this.bot.api.sendMessageDraft(chatId, session.draftId, '')
      }
      return
    } catch (error) {
      // Rich drafts can be rejected outright (older Bot API). The plain variant
      // carries the same information with no markdown syntax to fail on.
      const render = plainRender
      if (render) {
        try {
          await this.bot.api.sendMessageDraft(
            chatId,
            session.draftId,
            truncateTelegramText(render, 4096),
          )
          return
        } catch {
          // Fall through to the universally supported activity indicator.
        }
      }
      console.warn('[connector] Telegram live draft fell back to typing:', formatAdapterError(error))
      session.typingFallback = true
    }
  }

  private async finishDraft(conversationId: string): Promise<void> {
    const session = this.drafts.get(conversationId)
    if (session) {
      this.stopDraft(conversationId)
      await session.pending.catch(() => undefined)
    }
    this.markDraftFinished(conversationId)
  }

  private stopDraft(conversationId: string): void {
    const session = this.drafts.get(conversationId)
    if (!session) return
    session.stopped = true
    if (session.timer) clearTimeout(session.timer)
    this.drafts.delete(conversationId)
  }

  private stopAllDrafts(): void {
    for (const conversationId of [...this.drafts.keys()]) this.stopDraft(conversationId)
  }

  private armDraftHeartbeat(conversationId: string, session: TelegramDraftSession): void {
    if (session.stopped || this.drafts.get(conversationId) !== session) return
    if (session.timer) clearTimeout(session.timer)
    // A live activity frame must tick on the ANIMATION cadence; a narration
    // draft only needs to outlive Telegram's typing TTL. Using the typing
    // interval here would freeze the spinner at one frame per 4s.
    const delay = session.activity ? TELEGRAM_ACTIVITY_RENDER_MS : TELEGRAM_TYPING_HEARTBEAT_MS
    session.timer = setTimeout(() => {
      void this.queueDraftRefresh(conversationId, session).catch((error) => {
        this.tracker.degraded(error)
        console.warn('[connector] Telegram owner-chat activity refresh failed:', formatAdapterError(error))
      }).finally(() => this.armDraftHeartbeat(conversationId, session))
    }, delay)
    session.timer.unref?.()
  }

  private markDraftFinished(conversationId: string): void {
    if (this.finishedDrafts.size >= MAX_FINISHED_DRAFTS) {
      const oldest = this.finishedDrafts.values().next().value
      if (oldest !== undefined) this.finishedDrafts.delete(oldest)
    }
    this.finishedDrafts.add(conversationId)
  }
}

async function waitForResumeGap(options: {
  signal: AbortSignal
  intervalMs: number
  gapMs: number
  now?: () => number
}): Promise<boolean> {
  const now = options.now ?? Date.now
  let expectedAt = now() + options.intervalMs
  while (!options.signal.aborted) {
    await abortableDelay(options.intervalMs, options.signal)
    if (options.signal.aborted) return false
    const current = now()
    if (current - expectedAt >= options.gapMs) return true
    expectedAt = current + options.intervalMs
  }
  return false
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal.addEventListener('abort', finish, { once: true })
  })
}

export function telegramDraftId(conversationId: string): number {
  const value = createHash('sha256').update(conversationId).digest().readUInt32BE(0) & 0x7fff_ffff
  return value || 1
}

function telegramNumericChatId(chatId: string | undefined): number {
  if (!chatId) throw new Error('Telegram private chat is not linked')
  const numeric = Number(chatId)
  if (!Number.isSafeInteger(numeric)) throw new Error('Telegram private chat id is invalid')
  return numeric
}

export function telegramConnectorRegistration(
  proxy: ConnectorProxyTransport = DIRECT_CONNECTOR_PROXY_TRANSPORT,
): ConnectorAdapterRegistration {
  return { definition: TELEGRAM_CONNECTOR_DEFINITION, create: () => new TelegramConnectorAdapter({ proxy }) }
}

async function publishTelegramCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(TELEGRAM_CONNECTOR_DEFINITION.commands.map(({ name, description }) => ({
    command: name,
    description,
  })))
}

export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function toInlineKeyboard(
  actions: Array<Array<{ text: string; data: string }>>,
): InlineKeyboard | undefined {
  if (actions.length === 0) return undefined
  const keyboard = new InlineKeyboard()
  for (const [index, row] of actions.entries()) {
    if (index > 0) keyboard.row()
    for (const button of row) keyboard.text(button.text, button.data)
  }
  return keyboard
}

function sessionKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
}

/**
 * True when Telegram refused an edit because nothing actually changed.
 *
 * This is a SUCCESS in disguise, not a failure: the message already carries the
 * content and markup we asked for. Treating it as an error is what made
 * `/watchers` appear broken whenever the live board was already up to date.
 */
function isTelegramMessageNotModified(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  if (error.error_code !== 400) return false
  return error.description.toLowerCase().includes('message is not modified')
}

/**
 * True when Telegram says the message no longer exists.
 *
 * Tells "the operator deleted the board" (recoverable: post a fresh one) apart
 * from a real failure (must surface, not silently re-post).
 */
function isTelegramMessageGone(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false
  if (error.error_code === 404) return true
  if (error.error_code !== 400) return false
  const description = error.description.toLowerCase()
  return description.includes('message to edit not found')
    || description.includes('message_id_invalid')
    || description.includes('message can not be edited')
    || description.includes('message cant be edited')
}

function requiredString(config: ConnectorAdapterConfig, key: string): string {
  const value = config.settings[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Telegram setting ${key} is required`)
  return value.trim()
}

function optionalString(config: ConnectorAdapterConfig, key: string): string | undefined {
  const value = config.settings[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
