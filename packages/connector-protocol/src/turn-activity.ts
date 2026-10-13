/**
 * Live turn-activity rendering — the ephemeral "what is it doing right now"
 * line a chat transport shows while an Agent turn runs.
 *
 * Pure: no I/O, no clock of its own (the caller passes what it knows). It lives
 * in the shared protocol package so every transport renders the SAME activity
 * from the same structured input, and so the tool-name vocabulary is defined
 * once rather than re-guessed per adapter.
 *
 * Why the shape is a header, a blockquote, and a list: a chat message has no
 * layout primitives — no CSS, no flexbox, no width. The desktop UI draws this
 * same activity as a COLLAPSED disclosure group (see `ConversationTranscript.tsx`,
 * `ConversationActivityGroup`), and a Telegram draft is always collapsed. This
 * renderer therefore mirrors that collapsed row — one header, the tool names as
 * meta, and a line only for a failure — rather than the expanded tool list.
 */

import type { OwnerChatActivity, OwnerChatTool } from './types.js'

/**
 * Map a raw tool name to a present-participle phrase.
 *
 * Tool names are vendor-shaped (`read_file`, `mcp__foo__bar`, `Bash`) and often
 * long. A person watching a chat wants "Reading a file", not
 * `mcp__openalice__read_file`. Unknown names degrade to a readable de-snake
 * form rather than being swallowed, so a new tool is visible immediately.
 */
const TOOL_PHRASES: Record<string, string> = {
  // File + shell
  read_file: 'Reading a file',
  read: 'Reading a file',
  readfile: 'Reading a file',
  write_file: 'Writing a file',
  write: 'Writing a file',
  writefile: 'Writing a file',
  edit_file: 'Editing a file',
  edit: 'Editing a file',
  multi_replace_string_in_file: 'Editing files',
  replace_string_in_file: 'Editing a file',
  create_file: 'Creating a file',
  list_dir: 'Listing a directory',
  file_search: 'Searching files',
  grep_search: 'Searching the codebase',
  bash: 'Running a command',
  shell: 'Running a command',
  run_in_terminal: 'Running a command',
  terminal: 'Running a command',

  // Research
  fetch_webpage: 'Reading a web page',
  web_fetch: 'Reading a web page',
  web_search: 'Searching the web',
  search: 'Searching',

  // Subagents / planning
  runsubagent: 'Running a sub-agent',
  task: 'Running a sub-agent',
  manage_todo_list: 'Updating the plan',
  update_plan: 'Updating the plan',

  // Trading surface
  tradingcommit: 'Preparing a trade',
  placeorder: 'Placing an order',
  marketbars: 'Fetching market data',
  marketquote: 'Fetching a quote',
}

function normalizeToolKey(name: string): string {
  const raw = name.trim().toLowerCase()
  // `mcp__server__tool` → `tool`; the server prefix is noise to a watcher.
  const tail = raw.includes('__') ? raw.slice(raw.lastIndexOf('__') + 2) : raw
  return tail.replace(/[\s-]+/g, '_')
}

/** `read_file` → `Read file` when nothing better is known. */
function humanizeToolName(name: string): string {
  const words = name.trim().split(/[_\s-]+/).filter(Boolean)
  if (words.length === 0) return 'Working'
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** A short readable phrase for a running tool. Empty for a blank name. */
export function describeToolActivity(name: string | undefined): string {
  if (!name || !name.trim()) return ''
  const key = normalizeToolKey(name)
  return TOOL_PHRASES[key] ?? humanizeToolName(name)
}

/** `19 actions · 1 failed` — empty when the turn has not called anything yet. */
export function describeToolCounts(activity: OwnerChatActivity): string {
  if (activity.toolCalls <= 0) return ''
  const calls = `${activity.toolCalls} ${activity.toolCalls === 1 ? 'action' : 'actions'}`
  return activity.toolFailures > 0 ? `${calls} \u00B7 ${activity.toolFailures} failed` : calls
}

/** The one status mark that earns a line. Successes are counted, not listed. */
const FAILED_MARK = '\u26A0\uFE0F'

/**
 * Braille spinner frames — the "the turn is alive right now" animation.
 *
 * Eight frames at the transport's own cadence. Braille rather than a rotating
 * `|/-\\` because it is a single fixed-width cell in every monospace font, so
 * the line never shifts horizontally as it animates.
 */
const SPINNER_FRAMES = ['\u28FE', '\u28FD', '\u28FB', '\u28BF', '\u287F', '\u285F', '\u286F', '\u28F7'] as const

export function brailleSpinner(frame: number): string {
  const index = Math.abs(Math.floor(frame)) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0]
}

/**
 * The short display label for a tool in the header meta: `bash`, `read`, `grep`…
 *
 * The collapsed desktop group renders its meta as `bash · read · grep`, so a
 * watcher can tell a shell command from a file read at a glance. Unknown tools
 * fall back to a lowercased first word rather than being hidden.
 */
const TOOL_LABELS: Record<string, string> = {
  bash: 'bash', shell: 'bash', run_in_terminal: 'bash', terminal: 'bash', command: 'bash',
  read: 'read', read_file: 'read', readfile: 'read', view: 'read',
  write: 'write', write_file: 'write', writefile: 'write', create_file: 'write',
  edit: 'edit', edit_file: 'edit', replace_string_in_file: 'edit', multi_replace_string_in_file: 'edit',
  grep_search: 'grep', grep: 'grep', file_search: 'grep', search: 'grep',
  list_dir: 'ls', ls: 'ls',
  fetch_webpage: 'http', web_fetch: 'http', web_search: 'http',
  runsubagent: 'agent', task: 'agent',
  manage_todo_list: 'plan', update_plan: 'plan',
}

/** How many distinct tool labels the header meta shows. */
const MAX_META_TOOLS = 3

/** `read_file` → `read`. Empty for a blank name, so an unnamed tool is skipped. */
export function toolLabel(name: string | undefined): string {
  if (!name || !name.trim()) return ''
  const key = normalizeToolKey(name)
  return TOOL_LABELS[key] ?? key.split('_')[0] ?? ''
}

/**
 * The unique tool labels for a turn, in first-seen order, capped.
 *
 * Mirrors the desktop group's `bash · read · grep` meta. A 19-action turn that
 * used six distinct tools must not grow the header without bound, so the tail
 * is elided rather than wrapped.
 */
export function describeToolMeta(tools: readonly OwnerChatTool[] | undefined): string {
  if (!tools || tools.length === 0) return ''
  const labels: string[] = []
  for (const tool of tools) {
    const label = toolLabel(tool.name)
    if (label && !labels.includes(label)) labels.push(label)
  }
  return joinToolLabels(labels)
}

/**
 * The header meta for a live activity payload.
 *
 * `recentTools` is the tail of the turn and normally carries the running tool,
 * but a minimal update may report only `currentTool`. Naming the in-flight tool
 * is the whole reason the meta exists, so it is folded in when absent rather
 * than leaving the header without it.
 */
export function activityToolMeta(activity: OwnerChatActivity): string {
  const recent = activity.recentTools ?? []
  const current = activity.currentTool
  const alreadyNamed = current !== undefined
    && recent.some((tool) => toolLabel(tool.name) === toolLabel(current))
  const tools = current && !alreadyNamed
    ? [...recent, { name: current, status: 'running' as const }]
    : recent
  return describeToolMeta(tools)
}

function joinToolLabels(labels: readonly string[]): string {
  if (labels.length === 0) return ''
  // The MOST RECENT tools, not the first. `recentTools` is already the tail of
  // the turn, so a 19-action turn should show what it is doing now rather than
  // the read it opened with. Older labels are elided, not the new ones.
  const shown = labels.slice(-MAX_META_TOOLS)
  const meta = shown.map((label) => `\`${label}\``).join(' ')
  return labels.length > MAX_META_TOOLS ? `\u2026 ${meta}` : meta
}

/** `420ms` → `0.4s`; `65000ms` → `1m 5s`. Absent when never measured. */
export function formatToolDuration(durationMs: number | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return ''
  // Sub-100ms is a real result (a cached read, a trivial grep) but `(0s)` reads
  // as a bug. Say it was fast rather than rounding it to nothing.
  if (durationMs < 100) return '<0.1s'
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs / 100) / 10)}s`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/**
 * One line per FAILED tool, oldest first. Successes are counted, never listed.
 *
 * - `⚠️ Running a command (1.2s): exit code 1` — what failed, and why
 *
 * The desktop group also force-expands on failure (`setOpen(failedCount > 0)`),
 * because a failure is the one outcome a watcher must be able to act on. A
 * successful call changes nothing the reader would do next, so enumerating it
 * only grows a 19-tool turn into a wall of lines the draft has no room for.
 * A running tool is named in the header meta instead of getting its own row.
 */
export function renderFailedTools(tools: readonly OwnerChatTool[] | undefined): string {
  if (!tools || tools.length === 0) return ''
  return tools
    .filter((tool) => tool.status === 'failed')
    .map((tool) => {
      const label = describeToolActivity(tool.name) || tool.name
      const duration = formatToolDuration(tool.durationMs)
      const timing = duration ? ` (${duration})` : ''
      const reason = tool.error ? `: ${tool.error}` : ''
      return `${FAILED_MARK} ${label}${timing}${reason}`
    })
    .join('\n')
}

/**
 * The live header: status, action count, failures, and the tool-name meta.
 *
 * Mirrors the desktop collapsed group's single row — `19 actions` as the title
 * and `bash · read · grep` as the meta — so both surfaces agree on what a
 * running turn looks like. Exactly two shapes, because there are exactly two
 * states worth distinguishing:
 *   `⣾ 🧠 Thinking…`                        — no tool has run yet
 *   `⣾ Working · 19 actions · bash read grep` — work is under way
 */
function renderHeader(activity: OwnerChatActivity, frame: number, meta: string, emphasize = false): string {
  const spinner = brailleSpinner(frame)
  const counts = describeToolCounts(activity)
  if (!counts) return `${spinner} \uD83E\uDDE0 Thinking\u2026`
  const status = emphasize ? '**Working**' : 'Working'
  return meta ? `${spinner} ${status} \u00B7 ${counts} \u00B7 ${meta}` : `${spinner} ${status} \u00B7 ${counts}`
}

/**
 * The whole ephemeral line as PLAIN text.
 *
 * The header, the turn's latest COMPLETE narration line, then one line per
 * failure. The narration is the model's own sentence introducing the current
 * work — it rides this slot so the activity bar reads as progress rather than a
 * bare counter, and because the transport EDITS the slot in place it must be a
 * finished sentence, never the token stream (see the `narration` field).
 *
 * No markdown syntax at all: this variant is what `sendMessageDraft` falls back
 * to when rich drafts are unavailable, and a fallback that leaks literal
 * backticks and `>` markers reads worse than no formatting.
 */
export function renderTurnActivity(
  activity: OwnerChatActivity,
  frame: number,
): string {
  const meta = activityToolMeta(activity).replace(/`/g, '')
  const lines = [renderHeader(activity, frame, meta)]
  if (activity.narration) lines.push(activity.narration)
  const failures = renderFailedTools(activity.recentTools)
  if (failures) lines.push(failures)
  return lines.join('\n')
}

/**
 * The whole ephemeral line as a RICH card.
 *
 * Same information as the plain variant, but the tool-name meta moves into a
 * blockquote so the header stays one scannable line instead of trailing into an
 * unbounded list of names. That quote block is the closest a chat message gets
 * to the desktop group's separate meta column, and it is why this variant needs
 * Bot API 10.1 rich-message rendering rather than plain text.
 */
export function renderTurnActivityRich(
  activity: OwnerChatActivity,
  frame: number,
): string {
  const meta = activityToolMeta(activity)
  const lines = [renderHeader(activity, frame, '', true)]
  // Narration sits between the status header and the tool meta, mirroring the
  // desktop activity group where the model's sentence introduces the work and
  // the tool list is the supporting detail beneath it.
  if (activity.narration) lines.push('', activity.narration)
  if (meta) lines.push('', `> ${meta}`)
  const failures = renderFailedTools(activity.recentTools)
  if (failures) lines.push('', failures)
  return lines.join('\n')
}
