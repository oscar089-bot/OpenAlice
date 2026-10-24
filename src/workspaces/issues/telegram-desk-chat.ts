/**
 * Connector phone-desk chat hop.
 *
 * Connector only transports. Each adapter's Issue comments are that
 * specialist's transcript. Delivery syntax is interpreted by Connector using the source of
 * runs explicitly stamped with the connector-cron-issue execution profile.
 * Sealed mid-turn text blocks also project so the phone chat does not
 * wait for the final reply.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import {
  builtinConnectorHasCapability,
  ConnectorClient,
  type InboundAttachment,
  type InboundOwnerMessage,
} from '@traderalice/connector-protocol'

import type { WorkspaceConversationControl } from '../../core/workspace-tool-center.js'
import type { IProvenanceStore } from '../../core/provenance-store.js'
import { resolveConnectorUrl } from '../../services/connector-client/index.js'
import type { HeadlessTaskRecord } from '../headless-task-registry.js'
import { sessionSignature } from '../session-signature.js'
import {
  appendIssueComment,
  updateIssueCommentDelivery,
  type IssueComment,
} from './comments.js'
import { dispatchIssueCommentReply } from './comment-delivery.js'
import {
  findConnectorDesks,
  type ConnectorDesk,
} from './connector-desk.js'
import { projectDeskLifecycle } from './telegram-desk-project.js'

export {
  projectDeskLifecycle,
  shouldProjectDeskComment,
} from './telegram-desk-project.js'

export interface ConnectorDeskChatHost {
  listWorkspaces(): readonly { id: string; dir: string }[]
  getWorkspace(id: string): { id: string; dir: string } | undefined
  provenanceStore(): IProvenanceStore | undefined
  conversation(): WorkspaceConversationControl | undefined
  /** True while a scheduled fire or comment reply for this desk is running. */
  deskGenerating?(desk: ConnectorDesk): boolean
}

/** @deprecated Use {@link ConnectorDeskChatHost}. */
export type TelegramDeskChatHost = ConnectorDeskChatHost

export function telegramDeskHasRunningWork(
  tasks: readonly Pick<HeadlessTaskRecord, 'status' | 'trigger' | 'inquiry'>[],
  desk: { wsId: string; issue: { id: string } },
): boolean {
  return tasks.some((task) => task.status === 'running' && isDeskTask(task, desk))
}

/** The one in-flight turn for a desk, if any. The desk admits one run at a time. */
export function findRunningDeskTask(
  tasks: readonly HeadlessTaskRecord[],
  desk: { wsId: string; issue: { id: string } },
): HeadlessTaskRecord | undefined {
  return tasks.find((task) => task.status === 'running' && isDeskTask(task, desk))
}

function isDeskTask(
  task: Pick<HeadlessTaskRecord, 'trigger' | 'inquiry'>,
  desk: { wsId: string; issue: { id: string } },
): boolean {
  const trigger = task.trigger
  if (trigger?.kind === 'issue' && trigger.workspaceId === desk.wsId && trigger.issueId === desk.issue.id) {
    return true
  }
  const subject = task.inquiry?.subject
  return subject?.kind === 'issue' && subject.workspaceId === desk.wsId && subject.issueId === desk.issue.id
}

/** One inbound stays as-is. Several become one stacked comment, each quoted. */
export function formatTelegramInboundStack(texts: readonly string[]): string {
  const parts = texts.map((text) => text.trim()).filter((text) => text.length > 0)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0] ?? ''
  return parts.map(quoteInboundMessage).join('\n')
}

function quoteInboundMessage(text: string): string {
  return text.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>')).join('\n')
}

/** Extension allow-list. The sender's filename is never trusted for the path —
 *  only the declared media type, so an inbound name cannot traverse or pick an
 *  executable suffix. */
const INBOUND_MEDIA_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * Write the owner's inbound images into the Workspace and return the markdown
 * references that let the coding agent open them.
 *
 * The desk turn is a headless CLI run whose cwd IS the Workspace, so a relative
 * path in the Issue comment is a path the model can read with its native file
 * tool. Content-addressed names make a re-delivery idempotent and prevent two
 * different photos from colliding.
 *
 * Several images in one message are all kept, in the order Telegram sent them.
 */
async function persistInboundAttachments(
  workspaceDir: string,
  attachments: readonly InboundAttachment[] | undefined,
): Promise<string[]> {
  if (!attachments?.length) return []
  const blocks: string[] = []
  for (const attachment of attachments) {
    const extension = INBOUND_MEDIA_EXTENSION[attachment.mediaType]
    if (!extension) continue
    try {
      const bytes = Buffer.from(attachment.contentBase64, 'base64')
      if (bytes.byteLength === 0) continue
      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
      const relative = join('.alice', 'inbox-media', `${digest}.${extension}`)
      const absolute = join(workspaceDir, relative)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, bytes)
      blocks.push(`![image](${relative.split(sep).join('/')})`)
    } catch {
      // A single unreadable image must not lose the owner's text or the other
      // images in the same message.
    }
  }
  return blocks
}

export async function ingestTelegramOwnerMessage(
  host: ConnectorDeskChatHost,
  message: InboundOwnerMessage,
  client?: ConnectorClient,
): Promise<{ ok: true; comment: IssueComment } | { ok: false; reason: string }> {
  return ingestConnectorOwnerMessages(host, [message], client)
}

export async function ingestTelegramOwnerMessages(
  host: ConnectorDeskChatHost,
  messages: readonly InboundOwnerMessage[],
  client?: ConnectorClient,
): Promise<{ ok: true; comment: IssueComment } | { ok: false; reason: string }> {
  return ingestConnectorOwnerMessages(host, messages, client)
}

export async function ingestConnectorOwnerMessages(
  host: ConnectorDeskChatHost,
  messages: readonly InboundOwnerMessage[],
  client: ConnectorClient = new ConnectorClient(resolveConnectorUrl()),
): Promise<{ ok: true; comment: IssueComment } | { ok: false; reason: string }> {
  const connectorId = messages[0]?.connectorId
  if (!connectorId) return { ok: false, reason: 'empty' }
  if (messages.some((message) => message.connectorId !== connectorId)) {
    return { ok: false, reason: 'mixed_connector' }
  }
  if (!builtinConnectorHasCapability(connectorId, 'desk')) {
    return { ok: false, reason: 'unsupported_connector' }
  }
  const desk = await findLiveDesk(host, connectorId)
  if (!desk) return { ok: false, reason: 'desk_disabled' }
  const workspace = host.getWorkspace(desk.wsId)
  if (!workspace) return { ok: false, reason: 'workspace_missing' }

  const texts = messages.map((message) => message.text ?? '')
  const attachmentBlocks = await Promise.all(
    messages.map((message) => persistInboundAttachments(workspace.dir, message.attachments)),
  )
  const markdown = formatTelegramInboundStack(
    texts.map((text, index) => [text, ...(attachmentBlocks[index] ?? [])].filter(Boolean).join('\n')),
  )
  if (!markdown) return { ok: false, reason: 'empty' }

  const stableEvents = messages.map((message) => message.eventId).filter((id): id is string => Boolean(id))
  const commentId = stableEvents.length === messages.length
    ? `${connectorId}-${createHash('sha256').update(stableEvents.join('\0')).digest('hex').slice(0, 24)}`
    : `${connectorId}-${randomUUID()}`
  const appended = await appendIssueComment(workspace.dir, desk.issue.id, 'human', markdown, {
    id: commentId,
    via: connectorId,
  })
  if (!appended.ok) {
    return { ok: false, reason: appended.reason === 'invalid' ? appended.error : 'issue_missing' }
  }
  if (!appended.created) return { ok: true, comment: appended.comment }

  await host.provenanceStore()?.append({
    artifact: { kind: 'issue', workspaceId: desk.wsId, issueId: desk.issue.id },
    action: 'commented',
    origin: { kind: 'external', system: connectorId },
    at: Date.now(),
  })

  const conversation = host.conversation()
  const dispatched = await dispatchIssueCommentReply({
    conversation,
    issueWorkspaceId: desk.wsId,
    issue: appended.issue,
    comment: appended.comment,
    source: { kind: 'human' },
  })
  if (dispatched.status !== 'not_requested') {
    await updateIssueCommentDelivery(workspace.dir, desk.issue.id, appended.comment.id, dispatched.delivery)
  }
  if (dispatched.status !== 'scheduled') {
    const reason = dispatched.status === 'failed'
      ? dispatched.delivery.error
      : 'No Agent reply was scheduled for this message.'
    await projectDeskLifecycle({
      issue: appended.issue,
      conversationId: appended.comment.id,
      phase: 'failed',
      text: `OpenAlice could not start the Agent: ${reason}`,
      client,
    }).catch(() => undefined)
  }
  return { ok: true, comment: appended.comment }
}

export async function stampTelegramDeskScheduledFire(input: {
  host: ConnectorDeskChatHost
  workspaceId: string
  issueId: string
  task: HeadlessTaskRecord
  assistantText?: string | null
  client?: ConnectorClient
}): Promise<IssueComment | null> {
  // A native CLI can emit partial assistant text before exiting with an error
  // or interruption. Keep that diagnostic in the run record, but do not turn
  // it into a durable phone-desk reply or project it to Telegram.
  if (input.task.status !== 'done') return null
  const text = input.assistantText?.trim()
  if (!text) return null
  const triggerMetadata = input.task.trigger?.metadata
  // A phone-desk run reaches the chat through TWO triggers: the desk's own cron
  // fire, and a deterministic market watcher on an Issue the desk owns. The
  // watcher case used to be dropped here, so a fired watcher created a Session
  // and produced no analysis in Telegram at all. Both are desk-originated, so
  // both must project; anything else (a plain Issue run) still must not.
  const fromWatch = triggerMetadata?.kind === 'watch'
  if (!fromWatch && triggerMetadata?.kind !== 'connector-cron-issue') return null
  const workspace = input.host.getWorkspace(input.workspaceId)
  if (!workspace) return null
  const desks = await findConnectorDesks(input.host.listWorkspaces())
  const desk = desks.find((item) => item.wsId === input.workspaceId && item.issue.id === input.issueId)
  if (
    !desk
    || desk.issue.status === 'canceled'
    // A cron fire carries the connector it belongs to; a watch fire does not,
    // so the desk itself is the routing authority there.
    || (!fromWatch && desk.connectorId !== triggerMetadata?.connectorId)
  ) return null

  const appended = await appendIssueComment(
    workspace.dir,
    desk.issue.id,
    sessionSignature(input.task.resumeId),
    text,
    { id: `comment-fire-${input.task.taskId}` },
  )
  if (!appended.ok) return null
  await input.host.provenanceStore()?.append({
    artifact: { kind: 'issue', workspaceId: desk.wsId, issueId: desk.issue.id },
    action: 'commented',
    origin: {
      kind: 'session',
      workspaceId: input.task.wsId,
      resumeId: input.task.resumeId,
      agent: input.task.agent,
      execution: { kind: 'headless', taskId: input.task.taskId },
    },
    at: input.task.finishedAt ?? Date.now(),
    fingerprint: `telegram-desk-fire:${input.task.taskId}`,
  })
  return appended.comment
}

export async function pullTelegramDeskInbound(
  host: ConnectorDeskChatHost,
  client: ConnectorClient,
): Promise<void> {
  const claim = await client.claimInbound(AbortSignal.timeout(5_000))
  if (claim.items.length === 0) return
  const acknowledge: string[] = []
  const release: string[] = []
  const groups = new Map<string, typeof claim.items>()
  for (const message of claim.items) {
    const group = groups.get(message.connectorId) ?? []
    group.push(message)
    groups.set(message.connectorId, group)
  }
  for (const [connectorId, group] of groups) {
    if (!builtinConnectorHasCapability(connectorId, 'desk')) {
      console.warn('[connector] phone-desk inbound skipped: unsupported_connector', connectorId)
      acknowledge.push(...group.map((message) => message.queueId))
      continue
    }
    const desk = await findLiveDesk(host, connectorId)
    if (!desk || host.deskGenerating?.(desk)) {
      release.push(...group.map((message) => message.queueId))
      continue
    }
    const result = await ingestConnectorOwnerMessages(host, group, client)
    if (!result.ok) {
      console.warn(`[connector] ${connectorId} phone-desk inbound skipped:`, result.reason)
      release.push(...group.map((message) => message.queueId))
    } else {
      acknowledge.push(...group.map((message) => message.queueId))
    }
  }
  if (acknowledge.length > 0) await client.ackInbound(claim.claimId, acknowledge, AbortSignal.timeout(5_000))
  if (release.length > 0) await client.releaseInbound(claim.claimId, release, AbortSignal.timeout(5_000))
}

export function startTelegramDeskInboundPoll(
  host: ConnectorDeskChatHost,
  options: { intervalMs?: number; client?: ConnectorClient } = {},
): () => void {
  const client = options.client ?? new ConnectorClient(resolveConnectorUrl())
  const intervalMs = options.intervalMs ?? 1_500
  let stopped = false
  let running = false
  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      await pullTelegramDeskInbound(host, client)
    } catch {
      // Connector is optional.
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

async function findLiveDesk(
  host: ConnectorDeskChatHost,
  connectorId: string,
): Promise<ConnectorDesk | null> {
  const desks = await findConnectorDesks(host.listWorkspaces(), connectorId)
  const desk = desks[0]
  if (!desk || desk.issue.status === 'canceled') return null
  return desk
}
