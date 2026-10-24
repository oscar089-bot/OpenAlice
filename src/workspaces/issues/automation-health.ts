import type { HeadlessTaskStatus } from '../headless-task-registry.js'
import { issueAssigneeResumeId, type IssueStatus } from './declaration.js'
import type { IssueRunFailure } from './run-failure.js'

/** Operational state of a scheduled Issue. This is a live projection, never a
 * field persisted into the agent-editable markdown file: workflow status says
 * whether the work item is open, while automation health says whether its
 * scheduler/worker path can currently fulfill it. */
export type IssueAutomationHealthState =
  | 'inactive'
  | 'not_started'
  | 'due'
  | 'running'
  | 'healthy'
  | 'interrupted'
  | 'failed'
  | 'blocked'

export interface IssueAutomationHealth {
  state: IssueAutomationHealthState
  message: string
  /** Machine-readable reason for a blocked schedule. */
  blocker?: {
    kind: 'agent_runtime_missing'
    agent: string
    displayName: string
  }
  /** Latest scheduled execution, when one exists. Useful to jump from a health
   * warning to the authoritative run log without guessing from timestamps. */
  latestTaskId?: string
}

export type IssueAutomationOwnerState =
  | 'workspace'
  | 'ready'
  | 'missing'
  | 'retired'
  | 'deleted'
  | 'unbound'
  | 'workspace_missing'

type ExactIssueAutomationOwnerState = Exclude<IssueAutomationOwnerState, 'workspace'>

/** Map the authoritative exact-Session projection onto scheduler health. The
 * projection already owns Workspace presence, lifecycle, deletion, and native
 * resume availability, so health must not re-derive a weaker answer from only
 * the resume registry. */
export function issueAutomationOwnerState(
  assignee: string,
  assigneeSession?: { state: ExactIssueAutomationOwnerState },
): IssueAutomationOwnerState {
  if (!issueAssigneeResumeId(assignee)) return 'workspace'
  return assigneeSession?.state ?? 'missing'
}

/** Liveness of a deterministic market watcher, as persisted by the watch loop.
 *  Structural (no watch import) so this module stays dependency-free. */
export interface IssueWatchHealthInput {
  terminal: boolean
  lastChecked: string | null
  lastError: string | null
  errorCount: number
  backoffUntil: string | null
}

export interface IssueAutomationHealthInput {
  status: IssueStatus
  nowMs: number
  nextDueAtMs: number | null
  ownerState: IssueAutomationOwnerState
  /** Effective runtime after resolving exact Session, Issue override, then Workspace default. */
  runtime?: { agent: string; displayName: string; installed: boolean }
  latestRun?: { taskId: string; status: HeadlessTaskStatus; failure?: IssueRunFailure }
  /** Present when the Issue carries a `watch:`. A watched Issue has no calendar
   *  fire, so its liveness comes from the watch loop's persisted state instead
   *  of `nextDueAtMs`. */
  watch?: IssueWatchHealthInput
  /** Effective watch-loop cadence, supplied by the caller that owns the loop.
   *
   *  Passed in rather than imported so this module keeps its documented
   *  dependency-free, structural design. It exists because the healthy message
   *  used to hardcode "every 30 seconds" while the loop had already moved to 5s
   *  — a number that must come from the real loop or it drifts again. Omitted
   *  means the caller does not know the cadence, and the message says so
   *  without inventing an interval. */
  watchIntervalSeconds?: number
}

/** Resolve the Agent whose executable will service the next scheduled fire.
 * The caller supplies the exact Session Agent when applicable; otherwise the
 * Issue override and Workspace/default chain apply in order. */
export function issueAutomationRuntime(input: {
  sessionAgent?: string
  issueAgent?: string
  defaultAgent?: string
  availability: Readonly<Record<string, { installed: boolean } | undefined>>
  displayNameFor(agent: string): string | undefined
}): { agent: string; displayName: string; installed: boolean } | undefined {
  const agent = input.sessionAgent ?? input.issueAgent ?? input.defaultAgent
  if (!agent) return undefined
  return {
    agent,
    displayName: input.displayNameFor(agent) ?? agent,
    installed: input.availability[agent]?.installed ?? false,
  }
}

/** Derive one scheduler-health answer from authoritative stores. Ordering is
 * intentional: an in-flight run is allowed to finish even if its Session is
 * retired concurrently; after that run finishes, the retired owner blocks the
 * next dispatch. A past failure remains visible until a later successful run. */
export function issueAutomationHealth(input: IssueAutomationHealthInput): IssueAutomationHealth {
  const latest = input.latestRun
  const withLatest = (health: IssueAutomationHealth): IssueAutomationHealth =>
    latest ? { ...health, latestTaskId: latest.taskId } : health

  if (input.status === 'done' || input.status === 'canceled') {
    return withLatest({ state: 'inactive', message: `Schedule stopped because the Issue is ${input.status}.` })
  }
  if (latest?.status === 'running') {
    return { state: 'running', message: 'A scheduled run is in progress.', latestTaskId: latest.taskId }
  }
  if (input.ownerState === 'missing') {
    return withLatest({ state: 'blocked', message: 'Assigned Session does not exist. Choose an active Session or @new-each-run.' })
  }
  if (input.ownerState === 'retired') {
    return withLatest({ state: 'blocked', message: 'Assigned Session is retired. Reassign the Issue before its next run.' })
  }
  if (input.ownerState === 'unbound') {
    return withLatest({ state: 'blocked', message: 'Assigned Session has no resumable runtime conversation yet.' })
  }
  // A deleted owner is RECOVERABLE: the next fire recruits a replacement and
  // rewrites the Issue assignee. A live watcher therefore stays live instead of
  // showing a red blocker for a market check that is still running fine.
  // Missing/retired/workspace-missing owners stay hard blockers above, because
  // those cannot self-heal.
  if (input.ownerState === 'deleted' && !input.watch) {
    return withLatest({ state: 'blocked', message: 'Assigned Session is deleted. Reassign the Issue before its next run.' })
  }
  if (input.ownerState === 'workspace_missing') {
    return withLatest({ state: 'blocked', message: 'Assigned Session Workspace is unavailable. Restore it or reassign the Issue before its next run.' })
  }
  if (input.runtime && !input.runtime.installed) {
    return withLatest({
      state: 'blocked',
      message: `${input.runtime.displayName} is not installed or not on PATH. Install it before the next scheduled run.`,
      blocker: {
        kind: 'agent_runtime_missing',
        agent: input.runtime.agent,
        displayName: input.runtime.displayName,
      },
    })
  }
  if (latest?.status === 'interrupted' || latest?.failure?.kind === 'system_paused') {
    return {
      state: 'interrupted',
      message: latest.failure?.message ?? 'OpenAlice stopped while the latest scheduled run was active. It was not automatically retried.',
      latestTaskId: latest.taskId,
    }
  }
  if (latest?.status === 'failed') {
    return {
      state: 'failed',
      message: latest.failure?.message ?? 'Latest scheduled run failed. Inspect its Runs entry, then retry when ready.',
      latestTaskId: latest.taskId,
    }
  }
  // A watched Issue has no calendar slot; its liveness is the watch loop. This
  // precedes the null-`nextDueAtMs` check, which would otherwise report a
  // healthy watcher as a schedule with no future fire.
  if (input.watch) {
    const w = input.watch
    if (w.terminal) {
      return withLatest({ state: 'inactive', message: 'Watcher finished. Rewrite its watch to re-arm for the next phase.' })
    }
    if (w.errorCount > 0) {
      const backoffMs = w.backoffUntil ? Date.parse(w.backoffUntil) : Number.NaN
      const backingOff = Number.isFinite(backoffMs) && backoffMs > input.nowMs
      return withLatest({
        state: 'failed',
        message: w.lastError
          ? `${w.lastError}${backingOff ? ' Retrying with backoff.' : ''}`
          : 'The latest market check failed.',
      })
    }
    if (!w.lastChecked) {
      return withLatest({ state: 'not_started', message: 'Watcher armed and waiting for its first market check.' })
    }
    // Derived from the loop's own cadence rather than hardcoded, so this
    // operator-facing sentence can never drift from the real poll interval.
    const seconds = input.watchIntervalSeconds
    return withLatest({
      state: 'healthy',
      message: seconds !== undefined && Number.isFinite(seconds) && seconds > 0
        ? `Watcher is armed and checks the market every ${seconds} seconds.`
        : 'Watcher is armed and checks the market on its polling interval.',
    })
  }
  if (input.nextDueAtMs === null) {
    return withLatest({ state: 'blocked', message: 'Schedule has no future fire. Check its expression and timestamp.' })
  }
  if (input.nextDueAtMs !== null && input.nextDueAtMs <= input.nowMs) {
    return withLatest({ state: 'due', message: 'The schedule is due and waiting to dispatch.' })
  }
  if (latest?.status === 'done') {
    return { state: 'healthy', message: 'Latest scheduled run completed.', latestTaskId: latest.taskId }
  }
  return { state: 'not_started', message: 'Schedule is valid and has not run yet.' }
}
