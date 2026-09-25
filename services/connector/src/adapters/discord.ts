import type { Client } from 'discord.js'
import type {
  ConnectorAdapterConfig,
  ConnectorArtifactDelivery,
  ConnectorAdapterHealth,
  InboxNotification,
} from '@traderalice/connector-protocol'
import { DISCORD_CONNECTOR_DEFINITION } from '@traderalice/connector-protocol'
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
  classifyNetworkStartFailure,
  decodeInboxAttachments,
  decodeConnectorAttachment,
  formatInboxNotification,
} from './shared.js'
import { DiscordWatcherBoard } from './discord-watcher-board.js'
import { loadDiscordBoardState, saveDiscordBoardState, type DiscordBoardState } from './discord-board-store.js'

export class DiscordConnectorAdapter implements ConnectorAdapter {
  readonly id = 'discord'
  private readonly tracker = new AdapterHealthTracker(this.id)
  private client?: Client
  private ownerUserId?: string
  private readonly proxy: ConnectorProxyTransport
  private readonly board: DiscordWatcherBoard
  /** Adapter-owned sealed state path for the watcher→message map. */
  private readonly boardStatePath?: string
  /** Persisted board state: message ids + which cards are expanded. */
  private boardState: DiscordBoardState = { messages: {}, expanded: {} }
  /** Dedicated watcher-board channel, when the operator configured one. */
  private boardChannelId?: string
  /** Adapter context, held so a board button can enqueue an action. */
  private context?: ConnectorAdapterContext

  classifyStartFailure = classifyNetworkStartFailure

  constructor(options: { proxy?: ConnectorProxyTransport; boardStatePath?: string } = {}) {
    this.proxy = options.proxy ?? DIRECT_CONNECTOR_PROXY_TRANSPORT
    if (options.boardStatePath) this.boardStatePath = options.boardStatePath
    this.board = new DiscordWatcherBoard({
      client: () => this.client,
      ownerUserId: () => this.ownerUserId,
      boardChannelId: () => this.boardChannelId,
      knownState: () => this.boardState,
      persistState: async (state) => {
        // Transport state, not operator config: the settings mutation path
        // rejects undeclared keys, and a human must not see or edit this map.
        this.boardState = state
        await saveDiscordBoardState(state, this.boardStatePath)
      },
      canManage: (userId) => this.isOwner(userId),
      requestDelete: (watcherId) => this.requestWatchDelete(watcherId),
    })
  }

  async start(config: ConnectorAdapterConfig, context: ConnectorAdapterContext): Promise<void> {
    try {
      const discord = await import('discord.js')
      const {
        Client,
        Events,
        GatewayIntentBits,
        Partials,
      } = discord
      const applicationId = requiredString(config, 'applicationId')
      const botToken = requiredString(config, 'botToken')
      this.ownerUserId = optionalString(config, 'ownerUserId')
      this.boardChannelId = optionalString(config, 'boardChannelId')
      this.context = context
      this.boardState = await loadDiscordBoardState(this.boardStatePath)

      this.registerCommands(context)
      await this.publishSlashCommands(applicationId, botToken, discord)

      const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
        partials: [Partials.Channel],
        ...(this.proxy.dispatcher ? { rest: { agent: this.proxy.dispatcher } } : {}),
      })
      this.client = client
      client.on(Events.InteractionCreate, async (interaction) => {
        // Board buttons are routed by custom_id, never by a collector: the
        // cards outlive the process, and a collector's view dies with it.
        if (interaction.isButton()) {
          await this.board.handleButton(interaction).catch(() => undefined)
          return
        }
        if (!interaction.isChatInputCommand()) return
        const handled = await context.commands.execute({
          connectorId: this.id,
          command: interaction.commandName,
          userId: interaction.user.id,
          chatId: interaction.channelId,
          reply: async (message) => {
            await interaction.reply({ content: message, ephemeral: false })
          },
        }).catch(async (error) => {
          this.tracker.degraded(error)
          if (!interaction.replied) await interaction.reply('Connector command failed. Check OpenAlice logs.').catch(() => undefined)
          return true
        })
        if (!handled && !interaction.replied) await interaction.reply('Unknown connector command.').catch(() => undefined)
      })
      client.on(Events.Error, (error) => this.tracker.degraded(error))

      const ready = new Promise<void>((resolveReady) => {
        client.once(Events.ClientReady, () => resolveReady())
      })
      await client.login(botToken)
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Discord gateway did not become ready within 15 seconds')), 15_000)
          timer.unref?.()
        }),
      ])
      if (this.ownerUserId) this.tracker.healthy(this.ownerUserId)
      else this.tracker.awaitingLink()
    } catch (error) {
      this.tracker.degraded(error)
      this.client?.destroy()
      this.client = undefined
      throw error
    }
  }

  async stop(): Promise<void> {
    this.board.stop()
    this.client?.destroy()
    this.client = undefined
    this.tracker.stopped()
  }

  /**
   * Reconcile the persistent watcher board against one Alice push. The board
   * owns its own message ids and pulse timer; this method only forwards state.
   */
  async syncWatcherBoard(board: import('@traderalice/connector-protocol').WatcherBoardSync): Promise<void> {
    if (!this.client?.isReady() || !this.ownerUserId) return
    await this.board.sync(board)
  }

  async deliver(notification: InboxNotification): Promise<void> {
    if (!this.client?.isReady()) throw new Error('Discord client is not ready')
    if (!this.ownerUserId) throw new Error('Discord owner is not linked')
    this.tracker.attempt()
    try {
      const user = await this.client.users.fetch(this.ownerUserId)
      const attachments = decodeInboxAttachments(notification)
      await user.send({
        content: formatInboxNotification(notification),
        ...(attachments.length > 0 ? {
          files: attachments.map((attachment) => ({
            attachment: attachment.content,
            name: attachment.filename,
          })),
        } : {}),
      })
      this.tracker.success(this.ownerUserId)
    } catch (error) {
      this.tracker.degraded(error)
      throw error
    }
  }

  async deliverArtifact(delivery: ConnectorArtifactDelivery): Promise<void> {
    await this.sendOwnerFile(delivery.attachment)
  }

  async sendOwnerFile(attachment: ConnectorArtifactDelivery['attachment'],
    _presentation: import('../core/reply-directives.js').ReplyMedia = 'file'): Promise<void> {
    if (!this.client?.isReady()) throw new Error('Discord client is not ready')
    if (!this.ownerUserId) throw new Error('Discord owner is not linked')
    this.tracker.attempt()
    try {
      const file = decodeConnectorAttachment(attachment)
      const user = await this.client.users.fetch(this.ownerUserId)
      // Local stickers are image attachments; native Discord stickers require registered IDs.
      await user.send({ files: [{ attachment: file.content, name: file.filename }] })
      this.tracker.success(this.ownerUserId)
    } catch (error) {
      this.tracker.degraded(error)
      throw error
    }
  }

  async sendOwnerText(text: string): Promise<void> {
    if (!this.client?.isReady()) throw new Error('Discord client is not ready')
    if (!this.ownerUserId) throw new Error('Discord owner is not linked')
    this.tracker.attempt()
    try {
      const user = await this.client.users.fetch(this.ownerUserId)
      await user.send({ content: text })
      this.tracker.success(this.ownerUserId)
    } catch (error) {
      this.tracker.degraded(error)
      throw error
    }
  }

  health(): ConnectorAdapterHealth {
    return this.tracker.get()
  }

  private registerCommands(context: ConnectorAdapterContext): void {
    context.commands.register('link', async ({ userId, reply }) => {
      if (this.ownerUserId && this.ownerUserId !== userId) {
        await reply('This connector is already linked to another account.')
        return
      }
      this.ownerUserId = userId
      await context.updateSettings({ ownerUserId: userId })
      this.tracker.healthy(userId)
      await reply('Discord is linked to this OpenAlice installation.')
    })
    context.commands.register('status', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      await reply(`OpenAlice Connector Service: ${context.getServiceStatus()}. Discord: ${this.health().status}.`)
    })
    context.commands.register('test', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      const probeId = await context.sendTest(this.id)
      await reply(`Test notification sent. Probe: ${probeId}`)
    })
    context.commands.register('inbox', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      await reply('Inbox browsing is not implemented for Discord yet. Open Inbox in OpenAlice.')
    })
    context.commands.register('settings', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      await reply('Discord settings buttons are not implemented yet. Change Inbox push in OpenAlice → Settings → Connectors.')
    })
    context.commands.register('uta', async ({ userId, reply }) => {
      if (!this.isOwner(userId)) return reply('This command is only available to the linked owner.')
      await reply('UTA review buttons are not implemented for Discord yet. Approve pending trades in OpenAlice → Trading as Git.')
    })
  }

  private isOwner(userId: string): boolean {
    return Boolean(this.ownerUserId && this.ownerUserId === userId)
  }

  /**
   * Ask Alice to delete a watcher.
   *
   * The connector cannot delete watch state itself \u2014 Alice owns the watch store
   * and the board is a VIEW of it. So this enqueues an action and reports
   * acceptance, NOT completion: the card disappears on a later board push once
   * Alice has actually removed the watcher. Reporting "deleted" here would let a
   * refused or failed removal look identical to a successful one.
   */
  private async requestWatchDelete(input: { watcherId: string; workspaceId: string }): Promise<{ ok: boolean; message: string }> {
    if (!this.context) return { ok: false, message: 'Connector context is not available.' }
    if (!input.workspaceId) {
      return { ok: false, message: 'This card is not bound to a workspace yet; wait for the next board refresh.' }
    }
    try {
      await this.context.enqueueWatchRequest({
        action: 'delete',
        workspaceId: input.workspaceId,
        watcherId: input.watcherId,
      })
      return { ok: true, message: 'accepted' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  private async publishSlashCommands(
    applicationId: string,
    token: string,
    discord: typeof import('discord.js'),
  ): Promise<void> {
    const {
      ApplicationIntegrationType,
      InteractionContextType,
      REST,
      Routes,
      SlashCommandBuilder,
    } = discord
    const body = DISCORD_CONNECTOR_DEFINITION.commands.map(({ name, description }) => ({
      ...new SlashCommandBuilder().setName(name).setDescription(description).toJSON(),
      integration_types: [ApplicationIntegrationType.UserInstall],
      contexts: [InteractionContextType.BotDM],
    }))
    await new REST({
      version: '10',
      ...(this.proxy.dispatcher ? { agent: this.proxy.dispatcher } : {}),
    }).setToken(token).put(Routes.applicationCommands(applicationId), { body })
  }
}

export function discordConnectorRegistration(
  proxy: ConnectorProxyTransport = DIRECT_CONNECTOR_PROXY_TRANSPORT,
): ConnectorAdapterRegistration {
  return { definition: DISCORD_CONNECTOR_DEFINITION, create: () => new DiscordConnectorAdapter({ proxy }) }
}

function requiredString(config: ConnectorAdapterConfig, key: string): string {
  const value = config.settings[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Discord setting ${key} is required`)
  return value.trim()
}

function optionalString(config: ConnectorAdapterConfig, key: string): string | undefined {
  const value = config.settings[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
