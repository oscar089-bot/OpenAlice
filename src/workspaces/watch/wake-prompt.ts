/**
 * Wake-prompt construction for a fired watcher.
 *
 * The Issue's markdown What is the canonical, human-visible work definition AND
 * the exact scheduled prompt (see `issues/declaration.ts`). It is never
 * duplicated or overridden by a second field. What the fire path adds is the
 * *event*: which rule fired, at what price, and when — the facts the model
 * cannot reconstruct from the plan alone.
 *
 * The shape mirrors Vibe-Trading's `build_reconfirmation_prompt`: original
 * setup, then the current event, then an explicit instruction. That structure is
 * what lets the woken Session know which phase it is in and what to do next.
 */

import type { IssueRecord } from '../issues/declaration.js'

import type { WatchEvent, WatchSnapshot, WatchSpec } from './types.js'

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return String(value)
}

/** Human label for one fired rule. */
function describeEvent(event: WatchEvent): string {
  switch (event.eventType) {
    case 'TRIGGER_HIT': return 'Trigger met'
    case 'TRIGGER_CLOSE': return 'Candle close trigger met'
    case 'MANAGEMENT_ALERT': return 'Trade-management alert'
    case 'INVALIDATED': return 'Setup invalidated'
    case 'EXPIRED': return 'Watcher expired'
    case 'ERROR': return 'Watcher data error'
    default: return String(event.eventType)
  }
}

function eventLines(events: WatchEvent[], snapshot: WatchSnapshot): string[] {
  return events.map((event) => {
    const price = event.price ?? snapshot.price
    return `- ${describeEvent(event)}: ${event.message} (price ${formatNumber(price)})`
  })
}

/** The stored position, when the watcher manages an open trade. */
function positionLines(spec: WatchSpec): string[] {
  const position = spec.position
  if (!position) return []
  const parts = [`Side ${position.side}`, `entry ${formatNumber(position.entry)}`]
  if (typeof position.stop === 'number') parts.push(`stop ${formatNumber(position.stop)}`)
  if (position.targets?.length) parts.push(`targets ${position.targets.map((t) => formatNumber(t)).join(', ')}`)
  return [`- Position: ${parts.join(', ')}`]
}

/**
 * Build the prompt handed to the woken Session.
 *
 * Structure:
 *   1. The Issue's What — the plan the model wrote when it armed the watcher.
 *   2. What just happened — the fired rule(s), live price, observation time.
 *   3. The task — re-analyse and re-arm, following the plan above.
 */
export function buildWatchWakePrompt(
  issue: Pick<IssueRecord, 'id' | 'title' | 'what'>,
  spec: WatchSpec,
  events: WatchEvent[],
  snapshot: WatchSnapshot,
  options: { terminal: boolean },
): string {
  const header = [
    `A market watcher fired on Issue ${issue.id} (${issue.title}).`,
    '',
    '## Plan',
    '',
    issue.what.trim(),
    '',
    '## What happened',
    '',
    `- Pair: ${spec.pair} (${spec.assetClass}${spec.timeframe ? `, ${spec.timeframe}` : ''})`,
    `- Observed price: ${formatNumber(snapshot.price)}`,
    `- Observed at: ${snapshot.timestamp}`,
    ...eventLines(events, snapshot),
    ...positionLines(spec),
    '',
    '## Task',
    '',
  ]

  if (options.terminal) {
    header.push(
      'This watcher has reached a terminal state and will not fire again.',
      'Re-analyse the setup against the event above, then report your conclusion to the user.',
      'If the thesis still applies, rewrite this Issue with the next deterministic condition',
      'so the watcher can be re-armed for the next phase. Otherwise mark the Issue done.',
      '',
      // A watcher run is headless: its final assistant text lands in the run
      // record, which no chat reads. Without an explicit Inbox push the owner
      // never learns the re-analysis happened, and a silent failure is
      // indistinguishable from a quiet market.
      'This run is headless, so your reply does not reach the user on its own.',
      'You MUST publish your conclusion with `alice inbox push --body "<your analysis>"`',
      'before you finish. A run that ends without an Inbox push is treated as incomplete.',
    )
  } else {
    header.push(
      'Re-analyse the setup against the event above and report your conclusion to the user.',
      'If the thesis still applies, rewrite this Issue with the next deterministic condition',
      'so the watcher can be re-armed for the next phase. Otherwise mark the Issue done.',
      'Do not place orders or imply execution.',
      '',
      'This run is headless, so your reply does not reach the user on its own.',
      'You MUST publish your conclusion with `alice inbox push --body "<your analysis>"`',
      'before you finish. A run that ends without an Inbox push is treated as incomplete.',
    )
  }

  return header.join('\n')
}

/** Short machine-facing summary for the Discord alert. Never the model prompt. */
export function buildWatchAlert(
  issue: Pick<IssueRecord, 'id' | 'title'>,
  spec: WatchSpec,
  events: WatchEvent[],
  snapshot: WatchSnapshot,
): string {
  const lines = [
    `**Watcher fired** — ${issue.title} (\`${issue.id}\`)`,
    `\`${spec.pair}\` at ${formatNumber(snapshot.price)}`,
  ]
  for (const event of events) lines.push(`- ${describeEvent(event)}: ${event.message}`)
  return lines.join('\n')
}
