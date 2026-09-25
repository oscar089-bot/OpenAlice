/**
 * Live turn-activity rendering — the ephemeral "what is it doing right now"
 * line a chat transport shows while an Agent turn runs.
 *
 * Pure: no I/O, no clock of its own (the caller passes what it knows). It lives
 * in the shared protocol package so every transport renders the SAME activity
 * from the same structured input, and so the tool-name vocabulary is defined
 * once rather than re-guessed per adapter.
 *
 * Why a Unicode bar: a chat message has no layout primitives — no CSS, no
 * flexbox, no width. A run of `▰`/`▱` is the only way to draw a bar inside a
 * text message. On the desktop UI the same data is drawn with a real styled
 * element instead (see `IssueDetail.tsx`), which is why the bar is NOT reused
 * there.
 */

import type { OwnerChatActivity, OwnerChatTool } from './types.js'

const BAR_WIDTH = 12
/** Filled cell. A shade block reads as a gauge in a chat bubble, where the
 *  geometric `\u25B0` reads as a barcode and looks broken in some clients. */
const FILLED = '\u2592'
const EMPTY = '\u2591'

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

/**
 * A bar that advances with the tick rather than the data.
 *
 * A tool call can run far longer than Alice's 1s progress debounce, so a bar
 * derived from reported progress would sit frozen and read as a hang. Tying it
 * to the transport's own frame keeps it visibly alive, which is its entire job.
 *
 * Bracketed so it reads as a discrete gauge rather than trailing text.
 */
export function activityBar(frame: number, width: number = BAR_WIDTH): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const lit = (Math.max(0, Math.floor(frame)) % safeWidth) + 1
  return `[${FILLED.repeat(lit)}${EMPTY.repeat(Math.max(0, safeWidth - lit))}]`
}

/** `3 tools · 1 failed` — empty when the turn has not called anything yet. */
export function describeToolCounts(activity: OwnerChatActivity): string {
  if (activity.toolCalls <= 0) return ''
  const tools = `${activity.toolCalls} ${activity.toolCalls === 1 ? 'tool' : 'tools'}`
  return activity.toolFailures > 0 ? `${tools} \u00B7 ${activity.toolFailures} failed` : tools
}

/**
 * A status marker per tool, so a failure is attributable.
 *
 * Emoji rather than bare glyphs because this line is read in a chat client
 * where color is unavailable, and the prompt line below already carries the
 * textual identity. `⏳` stays deliberately STATIC: the headline owns the
 * animation, so exactly one thing on screen moves.
 */
const TOOL_STATUS_MARK: Record<OwnerChatTool['status'], string> = {
  running: '\u23F3',
  completed: '\u2705',
  failed: '\u26A0\uFE0F',
}

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
 * The shell-prompt channel for a tool: `bash`, `read`, `write`, `grep`…
 *
 * A prompt line reads `alice@{bash}:~$ Running…`. The channel exists so a
 * watcher can tell a shell command from a file read at a glance — the two feel
 * completely different when you are waiting on them. Unknown tools fall back to
 * a lowercased first word rather than being hidden.
 */
const TOOL_CHANNELS: Record<string, string> = {
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

export function toolChannel(name: string | undefined): string {
  if (!name || !name.trim()) return 'alice'
  const key = normalizeToolKey(name)
  const mapped = TOOL_CHANNELS[key]
  if (mapped) return mapped
  return key.split('_')[0] || 'alice'
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
 * One line per recent tool, oldest first.
 *
 * - `✅ Reading a file (0.4s)` — what it did, and how long it took
 * - `⚠️ Running a command: exit code 1` — what failed, and why
 * - `⣾ Writing a file` — in flight, so no duration yet
 *
 * A RUNNING row carries the spinner rather than a static mark. This is the row
 * a watcher stares at while a long command blocks the turn, and a frozen `⏳`
 * there is indistinguishable from a hung process. The description is kept on
 * every row rather than a bare `Done`: the earlier "count only" form could not
 * answer *which* tool ran, which was the whole reason this readout exists.
 */
export function renderRecentTools(tools: readonly OwnerChatTool[] | undefined, frame = 0): string {
  if (!tools || tools.length === 0) return ''
  return tools
    .map((tool) => {
      const mark = tool.status === 'running' ? brailleSpinner(frame) : TOOL_STATUS_MARK[tool.status]
      const label = describeToolActivity(tool.name) || tool.name
      const duration = tool.status === 'running' ? '' : formatToolDuration(tool.durationMs)
      const timing = duration ? ` (${duration})` : ''
      const reason = tool.status === 'failed' && tool.error ? `: ${tool.error}` : ''
      return `${mark} ${label}${timing}${reason}`
    })
    .join('\n')
}

/**
 * The whole ephemeral line: the live headline plus the tool tail.
 *
 * Activity only — no model prose. Narration belongs in the real reply, where it
 * is durable and in order. Mixing it into a slot that is overwritten on every
 * tick produced fragments that vanished mid-sentence.
 *
 * The headline has exactly two shapes, because there are exactly two states
 * worth distinguishing:
 *   `⣾ 🧠 Thinking…`              — no tool has run yet
 *   `⣾ alice@{bash}:~$ Running…`  — a tool is in flight
 * The spinner leads both so "alive" is one glance, and the prompt names WHAT is
 * running where a developer's eye already expects to find it.
 */
export function renderTurnActivity(
  activity: OwnerChatActivity,
  frame: number,
): string {
  const spinner = brailleSpinner(frame)
  const counts = describeToolCounts(activity)
  // Two headline shapes only. Once a tool finishes the model is reasoning about
  // its result, which is honestly "thinking" again — and the tool log below
  // still shows that work happened, so a third "Working" state would be a
  // distinction the reader cannot act on.
  const headline = activity.currentTool
    ? `${spinner} \`alice@{${toolChannel(activity.currentTool)}}:~$\` Running\u2026`
    : `${spinner} \uD83E\uDDE0 Thinking\u2026`
  const lines = [headline]
  // Nothing but the spinner until a tool actually runs.
  //
  // The counts line and the tool log are BOTH absent on a turn that has not
  // called a tool yet, so the slot reads as plain `Thinking` exactly like the
  // Discord surface did — no bar, no counters, no empty "Recent activity"
  // scaffolding. They appear the moment real work starts and stay for the rest
  // of the turn, which is what makes them worth reading.
  if (counts) lines.push(`\`${activityBar(frame)}\` ${counts}`)
  const tools = renderRecentTools(activity.recentTools, frame)
  if (tools) lines.push(tools)
  return lines.join('\n')
}
