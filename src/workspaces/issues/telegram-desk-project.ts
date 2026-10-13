import { ConnectorClient, OWNER_CHAT_TEXT_MAX, type OwnerChatActivity, type OwnerChatTool } from '@traderalice/connector-protocol'

import { resolveConnectorUrl } from '../../services/connector-client/index.js'
import type {
  HeadlessTaskInquiry,
  HeadlessTaskTrigger,
  HeadlessTaskTriggerMetadata,
} from '../headless-task-registry.js'
import type { HeadlessTurnProgress } from '../headless-progress.js'
import type { IssueComment } from './comments.js'
import {
  isConnectorDeskIssue,
  type IssueRecord,
} from './declaration.js'

export function normalizeDeskText(text: string): string {
  return text.trim().slice(0, OWNER_CHAT_TEXT_MAX)
}

/** Tail length of the tool list sent with each activity update.
 *
 * Bounded because this rides every progress publish: the newest entries are
 * what a watcher reads, and an unbounded list would grow the message until the
 * transport truncated it from the bottom — cutting off the current tool. */
const MAX_ACTIVITY_TOOLS = 8

/** Wire cap for the narration excerpt, matching `ownerChatActivitySchema`. */
const MAX_ACTIVITY_NARRATION = 400

/**
 * The turn's latest COMPLETE narration line, or undefined.
 *
 * Picks the last non-empty `text` block — not the accumulating `assistantText`
 * stream. The transport EDITS one slot in place, so a stream would rewrite a
 * half-written sentence on every token; the last finished block stays put
 * until the model actually starts a new thought, which is what makes editing
 * it read as progress. Whitespace is collapsed to one line because the slot
 * has no room for paragraphs, and the full prose still lands in the reply.
 */
function latestNarration(blocks: HeadlessTurnProgress['blocks']): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]
    if (block.type !== 'text') continue
    const text = block.text.replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, MAX_ACTIVITY_NARRATION)
  }
  return undefined
}

/**
 * Project a compact turn snapshot onto the wire activity shape.
 *
 * Only the tool NAME and a narration excerpt cross the boundary. Tool inputs and
 * outputs are dropped here rather than downstream: they are noisy and can carry
 * absolute paths, so the decision belongs at the projection edge.
 *
 * `currentTool` is the LAST tool still `running`. A turn can have several tools
 * in flight (parallel calls), and the most recently started one is the honest
 * answer to "what is it doing right now".
 *
 * `recentTools` carries the tail of the tool list WITH status. This is the part
 * that makes the readout truthful: a Read or a Grep finishes in well under
 * Alice's 1s progress debounce, so by the time a snapshot is published there is
 * often no `running` tool at all and the fast calls are invisible. Keeping the
 * tail (rather than only the in-flight one) is what shows that six tools ran and
 * that one of them failed.
 */
export function turnActivityFrom(
  progress: HeadlessTurnProgress,
): OwnerChatActivity | undefined {
  const { metrics, blocks } = progress
  const narration = latestNarration(blocks)
  // Nothing to say: no tool has run AND the model has not narrated yet. The
  // accepted phase already seeded the slot with `Thinking`, so an update with
  // neither would re-send the same render and buy nothing. Narration alone IS
  // worth a render — it is the sentence that says what the coming work is for.
  if (metrics.toolCalls <= 0 && !narration) return undefined
  let currentTool: string | undefined
  const tools: OwnerChatTool[] = []
  for (const block of blocks) {
    if (block.type !== 'tool') continue
    if (block.status === 'running') currentTool = block.name
    tools.push({
      name: block.name,
      status: block.status,
      ...(typeof block.durationMs === 'number' ? { durationMs: block.durationMs } : {}),
      ...(block.error ? { error: block.error } : {}),
    })
  }

  // A failure is a CURRENT condition, not a permanent record. Once any LATER
  // tool succeeds the turn has recovered, so its warning line and its share of
  // the "N failed" counter both clear. Without this, one early schema error
  // stayed on the transport through every later success, until eight newer
  // calls happened to evict it from the tail.
  const lastSuccessIndex = tools.findLastIndex((tool) => tool.status === 'completed')
  const isSuperseded = (tool: OwnerChatTool, index: number): boolean =>
    tool.status === 'failed' && index < lastSuccessIndex
  const visibleTools = tools.filter((tool, index) => !isSuperseded(tool, index))
  const unresolvedFailures = visibleTools.filter((tool) => tool.status === 'failed').length

  return {
    toolCalls: metrics.toolCalls,
    toolFailures: unresolvedFailures,
    ...(currentTool ? { currentTool } : {}),
    ...(narration ? { narration } : {}),
    ...(visibleTools.length > 0 ? { recentTools: visibleTools.slice(-MAX_ACTIVITY_TOOLS) } : {}),
  }
}

/** Stable id for a turn's single ephemeral activity slot.
 *
 * One id per TASK, not per text: the transport edits this one slot in place
 * while the turn runs, then drops it when the real reply lands. A text-derived
 * id would make every narration chunk its own permanent message. */
export function deskProgressMessageId(scopeId: string): string {
  return `desk-progress-${scopeId}`
}

export function deskProgressScope(task: {
  readonly taskId: string
  readonly communication?: import('../dispatch-communication.js').DispatchCommunication
  readonly inquiry?: Pick<HeadlessTaskInquiry, 'subject'>
  readonly trigger?: HeadlessTaskTrigger
}): { workspaceId: string; issueId: string; scopeId: string } | null {
  const communication = task.communication
  const reply = communication?.reply
  if (!communication?.delivery || !reply || (reply.kind !== 'issue-comment' && reply.kind !== 'issue-run')) return null
  return { workspaceId: reply.workspaceId, issueId: reply.issueId, scopeId: task.taskId }
}

export function shouldProjectDeskComment(
  issue: { connectorDesk?: string },
  comment: IssueComment,
  opts?: {
    /** Derived from the caller's server-owned Issue run, never tool arguments. */
    workspaceId?: string
    automated?: boolean
    phase?: 'progress' | 'final'
    progressScopeId?: string
    triggerMetadata?: HeadlessTaskTriggerMetadata
    delivery?: import('../dispatch-communication.js').DispatchCommunication['delivery']
  },
): boolean {
  if (!isConnectorDeskIssue(issue) || comment.via) return false
  // The owner's own Web-UI comment on the desk is already visible where it was
  // written. Relaying it back would echo the human as a bot message in the
  // owner chat; only agent-authored comments are projected.
  if (comment.author === 'human') return false
  return true
}

export async function projectDeskComment(
  issue: { connectorDesk?: string },
  comment: IssueComment,
  client: ConnectorClient = new ConnectorClient(resolveConnectorUrl()),
  opts?: {
    /** Derived from the caller's server-owned Issue run, never tool arguments. */
    workspaceId?: string
    automated?: boolean
    phase?: 'progress' | 'final'
    progressScopeId?: string
    triggerMetadata?: HeadlessTaskTriggerMetadata
    delivery?: import('../dispatch-communication.js').DispatchCommunication['delivery']
  },
): Promise<void> {
  const scope = opts?.progressScopeId ?? comment.replyTo
  if (!shouldProjectDeskComment(issue, comment) || !issue.connectorDesk) return
  const phase = opts?.phase ?? 'final'
  await client.sendOwnerMessage({
    id: `desk-${comment.id}`,
    adapterId: opts?.delivery?.connectorId ?? issue.connectorDesk,
    conversationId: scope ?? comment.id,
    phase,
    text: normalizeDeskText(comment.markdown) || undefined,
    workspaceId: opts?.delivery?.contentWorkspaceId ?? opts?.workspaceId,
    source: opts?.delivery?.source ?? (opts?.automated || opts?.triggerMetadata?.kind === 'connector-cron-issue' ? 'automation' : 'conversation'),
  }, AbortSignal.timeout(5_000))
}

export async function projectDeskLifecycle(input: {
  issue: Pick<IssueRecord, 'connectorDesk' | 'status'>
  conversationId: string
  phase: 'accepted' | 'failed'
  text?: string
  client?: ConnectorClient
}): Promise<void> {
  if (!isConnectorDeskIssue(input.issue) || input.issue.status === 'canceled') return
  const client = input.client ?? new ConnectorClient(resolveConnectorUrl())
  await client.sendOwnerMessage({
    id: `desk-${input.phase}-${input.conversationId}`,
    adapterId: input.issue.connectorDesk,
    conversationId: input.conversationId,
    phase: input.phase,
    ...(input.text ? { text: normalizeDeskText(input.text) } : {}),
  }, AbortSignal.timeout(5_000))
}
