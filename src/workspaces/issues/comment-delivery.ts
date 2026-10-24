import type {
  WorkspaceConversationCaller,
  WorkspaceConversationControl,
} from '../../core/workspace-tool-center.js'
import type { IProvenanceStore } from '../../core/provenance-store.js'
import type { HeadlessTaskRecord, HeadlessTaskStatus } from '../headless-task-registry.js'
import { sessionSignature } from '../session-signature.js'
import {
  appendIssueComment,
  updateIssueCommentDelivery,
  type IssueComment,
  type IssueCommentDelivery,
} from './comments.js'
import { renderIssueCommentPrompt } from './comment-prompt.js'
import { issueAssigneeResumeId, issueRunTimeoutMs, type IssueRecord } from './declaration.js'

export type IssueCommentDispatchResult =
  | { status: 'not_requested'; reason: 'non_human_note' | 'owner_commented' }
  | { status: 'scheduled'; delivery: Extract<IssueCommentDelivery, { state: 'pending' }> }
  | { status: 'failed'; delivery: Extract<IssueCommentDelivery, { state: 'failed' }> }

export function issueCommentReplyPrompt(input: {
  issueWorkspaceId: string
  issue: IssueRecord
  comment: IssueComment
}): string {
  const base = renderIssueCommentPrompt(input.issue.commentPrompt, {
    comment: input.comment.markdown,
    title: input.issue.title,
    id: input.issue.id,
    workspaceId: input.issueWorkspaceId,
    author: input.comment.author,
    what: input.issue.what,
  })
  // A desk keeps earlier Sessions' comments in the same history, so the owner
  // must be told which handle is answering now. A plain Issue reply has one
  // author and needs no such framing.
  const currentResumeId = issueAssigneeResumeId(input.issue.assignee)
  if (!input.issue.connectorDesk || !currentResumeId) return base
  return `${deskOwnershipPreamble({
    resumeId: currentResumeId,
    agent: input.issue.agent ?? 'agent',
  })}\n\n${base}`
}

/**
 * The ownership header a desk turn needs but a plain Issue reply does not.
 *
 * A phone desk keeps every earlier Session's comments in the same sidecar, so
 * a new owner sees history written by someone else. Without an explicit
 * statement of who is answering now, that history reads as its own prior turn
 * and the model continues a conversation it never had. Deleted Sessions are
 * absent here because deletion physically purges their rows.
 */
export function deskOwnershipPreamble(input: {
  resumeId: string
  agent: string
}): string {
  return [
    `You are the CURRENT Session for this phone chat: ${input.resumeId} (${input.agent}).`,
    'Any comment below authored by a different @resume-… handle is HISTORY from an earlier Session. Read it for context, but it is not your own prior turn and its conclusions may be stale.',
    `Anything written as @${input.resumeId} is you. Reply as this Session, for the message at the end.`,
  ].join('\n')
}

/**
 * A fixed Issue owner is a real colleague: comments from somebody else are
 * delivered to that exact product Session. Fresh-owner policies recruit via
 * the shared Issue dispatcher. Human comments on ordinary unassigned Issues
 * use the same provenance-aware fallback as Inbox: continue the
 * creator when attributable, otherwise recruit a reconstruction worker in the
 * Issue Workspace. That answering Session is a collaborator, not a new owner;
 * the Issue assignee and scheduling contract stay unchanged.
 *
 * Agent-authored comments on Issues without a fixed owner remain notes. This
 * avoids turning progress logging into an unsolicited worker fan-out.
 */
export async function dispatchIssueCommentReply(input: {
  conversation?: WorkspaceConversationControl
  issueWorkspaceId: string
  issue: IssueRecord
  comment: IssueComment
  authorResumeId?: string
  source?: WorkspaceConversationCaller
}): Promise<IssueCommentDispatchResult> {
  const targetResumeId = issueAssigneeResumeId(input.issue.assignee)
  if (targetResumeId === input.authorResumeId) {
    return { status: 'not_requested', reason: 'owner_commented' }
  }
  if (!targetResumeId && input.source?.kind !== 'human') {
    return { status: 'not_requested', reason: 'non_human_note' }
  }
  if (!input.conversation) {
    return {
      status: 'failed',
      delivery: {
        state: 'failed',
        ...(targetResumeId ? { targetResumeId } : {}),
        error: 'Issue conversation delivery is unavailable in this runtime.',
      },
    }
  }

  try {
    if (input.issue.assignee === '@new-then-resume' || input.issue.assignee === '@new-each-run') {
      if (!input.conversation.replyToIssue) throw new Error('Issue owner recruitment is unavailable in this runtime.')
      const result = await input.conversation.replyToIssue({
        workspaceId: input.issueWorkspaceId,
        issueId: input.issue.id,
        prompt: issueCommentReplyPrompt(input),
        commentId: input.comment.id,
        source: input.source,
      })
      return { status: 'scheduled', delivery: { state: 'pending', targetResumeId: result.resumeId, taskId: result.taskId } }
    }
    const target = targetResumeId
      ? { kind: 'resume' as const, resumeId: targetResumeId }
      : {
          kind: 'issue' as const,
          workspaceId: input.issueWorkspaceId,
          issueId: input.issue.id,
          action: 'created' as const,
        }
    const result = await input.conversation.ask({
      prompt: issueCommentReplyPrompt(input),
      target,
      timeoutMs: issueRunTimeoutMs(input.issue),
      ...(!targetResumeId ? { reconstruct: true } : {}),
      ...(input.source ? { source: input.source } : {}),
      subject: {
        kind: 'issue',
        workspaceId: input.issueWorkspaceId,
        issueId: input.issue.id,
        relation: targetResumeId ? 'owner' : 'creator',
        commentId: input.comment.id,
      },
    })
    if (result.status === 'unavailable') {
      const unavailableTargetResumeId = targetResumeId
        ?? result.resolution.attributedOrigin?.resumeId
      // A deleted owner is recoverable, not a dead end. Recruit a replacement
      // through the Issue dispatcher: it inherits the old Session's agent and
      // runtime and rewrites the assignee, so the human's message still gets an
      // answer instead of a "deleted-session" failure.
      if (result.resolution.reason === 'deleted-session' && input.conversation.replyToIssue) {
        const recruited = await input.conversation.replyToIssue({
          workspaceId: input.issueWorkspaceId,
          issueId: input.issue.id,
          prompt: issueCommentReplyPrompt(input),
          commentId: input.comment.id,
          ...(input.source ? { source: input.source } : {}),
        })
        return {
          status: 'scheduled',
          delivery: {
            state: 'pending',
            targetResumeId: recruited.resumeId,
            taskId: recruited.taskId,
          },
        }
      }
      return {
        status: 'failed',
        delivery: {
          state: 'failed',
          ...(unavailableTargetResumeId ? { targetResumeId: unavailableTargetResumeId } : {}),
          error: `Could not reach an Agent for this Issue: ${result.resolution.reason}.`,
        },
      }
    }
    return {
      status: 'scheduled',
      delivery: {
        state: 'pending',
        targetResumeId: result.resumeId,
        taskId: result.taskId,
      },
    }
  } catch (err) {
    return {
      status: 'failed',
      delivery: {
        state: 'failed',
        ...(targetResumeId ? { targetResumeId } : {}),
        error: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

/**
 * Finish the other half of comment delivery after the owner run exits. The
 * reply comment id is derived from the task id, so replaying completion after a
 * process or persistence retry cannot append the same answer twice.
 */
export async function recordIssueCommentReply(input: {
  issueWorkspaceId: string
  issueWorkspaceDir: string
  issueId: string
  sourceCommentId: string
  task: HeadlessTaskRecord
  status: HeadlessTaskStatus
  assistantText?: string | null
  error?: string
  provenanceStore: IProvenanceStore
}): Promise<'replied' | 'failed'> {
  const reply = input.assistantText?.trim()
  if (input.status === 'done' && reply) {
    const replyCommentId = `comment-reply-${input.task.taskId}`
    const appended = await appendIssueComment(
      input.issueWorkspaceDir,
      input.issueId,
      sessionSignature(input.task.resumeId),
      reply,
      { id: replyCommentId, replyTo: input.sourceCommentId },
    )
    if (!appended.ok) {
      throw new Error(
        appended.reason === 'invalid' ? appended.error : 'Issue disappeared before its reply was recorded.',
      )
    }
    await input.provenanceStore.append({
      artifact: { kind: 'issue', workspaceId: input.issueWorkspaceId, issueId: input.issueId },
      action: 'commented',
      origin: {
        kind: 'session',
        workspaceId: input.task.wsId,
        resumeId: input.task.resumeId,
        agent: input.task.agent,
        execution: { kind: 'headless', taskId: input.task.taskId },
      },
      at: input.task.finishedAt ?? Date.now(),
      fingerprint: `issue-comment-reply:${input.task.taskId}`,
    })
    const updated = await updateIssueCommentDelivery(
      input.issueWorkspaceDir,
      input.issueId,
      input.sourceCommentId,
      {
        state: 'replied',
        targetResumeId: input.task.resumeId,
        taskId: input.task.taskId,
        replyCommentId,
      },
    )
    if (!updated.ok) throw new Error(updated.error)
    return 'replied'
  }

  const failureText = input.error
    ?? (input.status === 'done'
      ? 'The Issue reply Agent finished without a final reply.'
      : `The Issue reply run ended as ${input.status}.`)
  const updated = await updateIssueCommentDelivery(
    input.issueWorkspaceDir,
    input.issueId,
    input.sourceCommentId,
    {
      state: 'failed',
      targetResumeId: input.task.resumeId,
      taskId: input.task.taskId,
      error: failureText,
    },
  )
  if (!updated.ok) throw new Error(updated.error)
  return 'failed'
}
