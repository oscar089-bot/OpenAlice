/**
 * Boot repair for an Issue whose `@new-then-resume` first fire was interrupted
 * before the Session captured a native runtime id.
 *
 * The first fire claims ownership by rewriting the Issue to `@<resumeId>`, but
 * the run can die — launcher restart, sleep, crash — before the adapter
 * announces `agentSessionId`. That claim is then permanently un-resumable:
 * every later fire fails `not_ready`, so the Issue still looks scheduled while
 * it can never run again. Release exactly that claim back to
 * `@new-then-resume` so the next scan recruits a fresh Session and the
 * condition that came true while OpenAlice was down is evaluated normally.
 *
 * The guard is deliberately narrow. A claim is only released when the Issue
 * still names that exact Session, the Session was born from an Issue
 * `new-then-resume` claim, and its latest execution is `interrupted` — i.e. the
 * first fire never produced a turn. A Session that ever ran keeps its
 * ownership, and an exact Session assigned by a human is never touched.
 */
import type { IProvenanceStore } from '../../core/provenance-store.js'
import type { Logger } from '../logger.js'
import type { HeadlessTaskRegistry } from '../headless-task-registry.js'
import { sessionPresence, type ResumeRegistry } from '../resume-registry.js'
import { NEW_THEN_RESUME_ASSIGNEE } from '../session-signature.js'
import type { WorkspaceRegistry } from '../workspace-registry.js'
import { issueMutation, issueMutationFingerprint } from './change-tracker.js'
import { issueAssigneeResumeId, readWorkspaceIssues } from './declaration.js'
import { updateIssueFields } from './mutate.js'

export interface UnboundIssueClaimRepairDeps {
  registry: Pick<WorkspaceRegistry, 'get'>
  resumeRegistry: Pick<ResumeRegistry, 'list'>
  headlessTasks: Pick<HeadlessTaskRegistry, 'latestForResumeId'>
  provenanceStore: IProvenanceStore
  logger: Logger
}

/** Release every un-resumable `new-then-resume` claim. Returns how many were released. */
export async function repairUnboundIssueClaims(deps: UnboundIssueClaimRepairDeps): Promise<number> {
  let released = 0
  for (const identity of deps.resumeRegistry.list()) {
    if (identity.lifecycle === 'retired' || sessionPresence(identity) === 'deleted') continue
    if (identity.agentSessionId) continue
    const createdBy = identity.metadata?.createdBy
    if (createdBy?.kind !== 'issue' || createdBy.policy !== 'new-then-resume') continue
    const latest = deps.headlessTasks.latestForResumeId(identity.resumeId)
    if (latest?.status !== 'interrupted') continue
    const workspace = deps.registry.get(identity.wsId)
    if (!workspace) continue
    const read = await readWorkspaceIssues(workspace.dir)
    const issue = read.ok ? read.issues.find((row) => row.id === createdBy.issueId) : undefined
    if (!issue || issueAssigneeResumeId(issue.assignee) !== identity.resumeId) continue

    const result = await updateIssueFields(workspace.dir, issue.id, {
      assignee: NEW_THEN_RESUME_ASSIGNEE,
    })
    if (!result.ok) {
      deps.logger.warn('issue.unbound_claim_release_failed', {
        wsId: workspace.id,
        issueId: issue.id,
        resumeId: identity.resumeId,
        reason: result.reason,
      })
      continue
    }
    const mutation = issueMutation(result.previous, result.issue)
    await deps.provenanceStore.append({
      artifact: { kind: 'issue', workspaceId: workspace.id, issueId: issue.id },
      action: 'updated',
      origin: { kind: 'unknown', reason: 'unbound-first-fire-recovery' },
      at: Date.now(),
      ...(mutation ? { mutation } : {}),
      fingerprint: issueMutationFingerprint(workspace.id, issue.id, result.issue),
    })
    released += 1
    deps.logger.info('issue.unbound_claim_released', {
      wsId: workspace.id,
      issueId: issue.id,
      resumeId: identity.resumeId,
      taskId: latest.taskId,
    })
  }
  return released
}
