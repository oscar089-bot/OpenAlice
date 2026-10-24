import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendIssueComment, readIssueComments, removeSessionComments } from './comments.js'
import { createIssue } from './mutate.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'issue-comment-purge-'))
  await createIssue(dir, { id: 'desk', title: 'Desk', assignee: '@resume-live' })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('removeSessionComments', () => {
  // Deleting a Session must remove its words from the sidecar the model reads.
  // A display-only filter would leave the conversation readable next turn.
  it('physically removes one Session comments and keeps the rest', async () => {
    await appendIssueComment(dir, 'desk', '@resume-dead', 'old question')
    await appendIssueComment(dir, 'desk', '@resume-live', 'current question')
    await appendIssueComment(dir, 'desk', 'human', 'owner note')

    expect(await removeSessionComments(dir, 'desk', 'resume-dead')).toEqual({ ok: true, removed: 1 })

    const after = await readIssueComments(dir, 'desk')
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.comments.map((comment) => comment.author)).toEqual(['@resume-live', 'human'])
    expect(after.comments.some((comment) => comment.markdown === 'old question')).toBe(false)
  })

  it('is idempotent and leaves unrelated authors untouched', async () => {
    await appendIssueComment(dir, 'desk', 'human', 'owner note')
    expect(await removeSessionComments(dir, 'desk', 'resume-never-existed')).toEqual({ ok: true, removed: 0 })
    const after = await readIssueComments(dir, 'desk')
    expect(after.ok && after.comments).toHaveLength(1)
  })

  // The owner's own messages are addressed TO a Session. Deleting that Session
  // must remove the user's side of that conversation too, or the deleted chat
  // stays half-visible in Activity and half-readable by the model.
  it('also removes the user messages that were routed to that Session', async () => {
    await appendIssueComment(dir, 'desk', 'human', 'message to the dead Session', {
      delivery: { state: 'replied', targetResumeId: 'resume-dead', taskId: 'run-1', replyCommentId: 'comment-reply-1' },
    })
    await appendIssueComment(dir, 'desk', 'human', 'message to the live Session', {
      delivery: { state: 'replied', targetResumeId: 'resume-live', taskId: 'run-2', replyCommentId: 'comment-reply-2' },
    })
    await appendIssueComment(dir, 'desk', '@resume-dead', 'dead answer')

    expect(await removeSessionComments(dir, 'desk', 'resume-dead')).toEqual({ ok: true, removed: 2 })

    const after = await readIssueComments(dir, 'desk')
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.comments.map((comment) => comment.markdown)).toEqual(['message to the live Session'])
  })

  // A comment with no delivery record is not attributable to any Session, so a
  // purge must never guess and delete it.
  it('keeps unattributed human comments', async () => {
    await appendIssueComment(dir, 'desk', 'human', 'plain note, never routed')
    expect(await removeSessionComments(dir, 'desk', 'resume-dead')).toEqual({ ok: true, removed: 0 })
    const after = await readIssueComments(dir, 'desk')
    expect(after.ok && after.comments.map((comment) => comment.markdown)).toEqual(['plain note, never routed'])
  })
})
