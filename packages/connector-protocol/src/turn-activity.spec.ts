import { describe, expect, it } from 'vitest'

import {
  activityToolMeta,
  brailleSpinner,
  describeToolActivity,
  describeToolCounts,
  describeToolMeta,
  formatToolDuration,
  renderFailedTools,
  renderTurnActivity,
  renderTurnActivityRich,
  toolLabel,
} from './turn-activity.js'

const base = { toolCalls: 0, toolFailures: 0 }

describe('describeToolActivity', () => {
  it('maps vendor tool names to readable phrases', () => {
    expect(describeToolActivity('read_file')).toBe('Reading a file')
    expect(describeToolActivity('run_in_terminal')).toBe('Running a command')
    expect(describeToolActivity('grep_search')).toBe('Searching the codebase')
  })

  it('strips an mcp server prefix before matching', () => {
    expect(describeToolActivity('mcp__openalice__read_file')).toBe('Reading a file')
  })

  // An unknown tool must stay VISIBLE, not be swallowed: a new capability
  // appearing in chat is how an operator learns it ran.
  it('humanizes an unknown tool instead of hiding it', () => {
    expect(describeToolActivity('some_new_tool')).toBe('Some New Tool')
  })

  it('returns empty for a blank name', () => {
    expect(describeToolActivity(undefined)).toBe('')
    expect(describeToolActivity('   ')).toBe('')
  })
})

describe('describeToolCounts', () => {
  it('stays empty before the first tool call', () => {
    expect(describeToolCounts(base)).toBe('')
  })

  // "actions" rather than "tools": it is the same noun the desktop collapsed
  // group uses for its title, so the two surfaces describe a turn identically.
  it('singularizes and reports failures', () => {
    expect(describeToolCounts({ ...base, toolCalls: 1 })).toBe('1 action')
    expect(describeToolCounts({ ...base, toolCalls: 3 })).toBe('3 actions')
    expect(describeToolCounts({ ...base, toolCalls: 3, toolFailures: 1 })).toBe('3 actions \u00B7 1 failed')
  })
})

describe('toolLabel', () => {
  it('maps a vendor tool name to a short display label', () => {
    expect(toolLabel('Bash')).toBe('bash')
    expect(toolLabel('read_file')).toBe('read')
    expect(toolLabel('grep_search')).toBe('grep')
  })

  // An unnamed tool must be skipped rather than rendered as an empty code span.
  it('returns empty for a blank name', () => {
    expect(toolLabel(undefined)).toBe('')
    expect(toolLabel('   ')).toBe('')
  })
})

describe('describeToolMeta', () => {
  it('dedupes labels and keeps first-seen order', () => {
    const meta = describeToolMeta([
      { name: 'Read', status: 'completed' },
      { name: 'Bash', status: 'completed' },
      { name: 'read_file', status: 'running' },
    ])
    expect(meta).toBe('`read` `bash`')
  })

  // A 19-action turn must not grow the header without bound, and what it shows
  // must be what it is doing NOW rather than the read it opened with.
  it('keeps the most recent labels and elides the older ones', () => {
    const meta = describeToolMeta([
      { name: 'Read', status: 'completed' },
      { name: 'Bash', status: 'completed' },
      { name: 'Write', status: 'completed' },
      { name: 'grep_search', status: 'completed' },
      { name: 'fetch_webpage', status: 'completed' },
    ])
    expect(meta).toBe('\u2026 `write` `grep` `http`')
    expect(meta).not.toContain('read')
  })

  it('stays empty when no tool has run', () => {
    expect(describeToolMeta(undefined)).toBe('')
    expect(describeToolMeta([])).toBe('')
  })
})

describe('activityToolMeta', () => {
  // A minimal progress update may report only the running tool. The header must
  // still name it, or the meta column vanishes mid-turn.
  it('names currentTool when recentTools is absent', () => {
    expect(activityToolMeta({ ...base, toolCalls: 1, currentTool: 'read_file' })).toBe('`read`')
  })

  it('does not duplicate a tool already present in recentTools', () => {
    const meta = activityToolMeta({
      ...base,
      toolCalls: 1,
      currentTool: 'read_file',
      recentTools: [{ name: 'Read', status: 'running' }],
    })
    expect(meta).toBe('`read`')
  })
})

describe('renderTurnActivity', () => {
  // Before any tool runs the slot is ONLY the spinner — no counters, no meta,
  // no empty scaffolding. A turn with nothing to report must not look busy.
  it('shows only the spinner before the first tool call', () => {
    expect(renderTurnActivity(base, 0)).toBe(`${brailleSpinner(0)} \uD83E\uDDE0 Thinking\u2026`)
    expect(renderTurnActivityRich(base, 0)).toBe(`${brailleSpinner(0)} \uD83E\uDDE0 Thinking\u2026`)
  })

  // The whole point of the reshape: a turn that ran nineteen tools collapses to
  // one header line plus one line per FAILURE, instead of a line per tool.
  it('collapses a many-tool turn to a header and only the failures', () => {
    const line = renderTurnActivity({
      ...base,
      toolCalls: 19,
      toolFailures: 1,
      recentTools: [
        { name: 'read_file', status: 'completed', durationMs: 420 },
        { name: 'Bash', status: 'failed', durationMs: 1_200, error: 'exit code 1' },
        { name: 'write_file', status: 'running' },
      ],
    }, 0)
    const lines = line.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('19 actions \u00B7 1 failed')
    expect(lines[0]).toContain('read bash write')
    // A success and a running tool get NO row; only the failure is attributable.
    expect(line).not.toContain('Reading a file')
    expect(line).not.toContain('Writing a file')
    expect(line).toContain('\u26A0\uFE0F Running a command (1.2s): exit code 1')
  })

  // The plain variant is what `sendMessageDraft` falls back to, and that call
  // does no markdown parsing. Leaking a literal backtick or `>` would be worse
  // than sending no formatting at all.
  it('emits no markdown syntax in the plain variant', () => {
    const line = renderTurnActivity({
      ...base,
      toolCalls: 2,
      recentTools: [
        { name: 'Read', status: 'completed' },
        { name: 'Bash', status: 'completed' },
      ],
    }, 0)
    expect(line).not.toContain('`')
    expect(line).not.toContain('>')
    expect(line).not.toContain('**')
    expect(line).toContain('read bash')
  })

  // The rich variant is the one that actually ships to a current Bot API: the
  // meta becomes a blockquote so it reads as a separate column.
  it('moves the tool meta into a blockquote in the rich variant', () => {
    const line = renderTurnActivityRich({
      ...base,
      toolCalls: 2,
      recentTools: [
        { name: 'Read', status: 'completed' },
        { name: 'Bash', status: 'completed' },
      ],
    }, 0)
    expect(line).toContain('> `read` `bash`')
    expect(line.split('\n')[0]).toContain('**Working**')
  })

  // A failed tool changes what the reader does next; a successful one does not.
  // This is the same reason the desktop group force-opens on failure.
  it('reports every failure, each with its reason', () => {
    const line = renderFailedTools([
      { name: 'Read', status: 'completed', durationMs: 420 },
      { name: 'Bash', status: 'failed', durationMs: 1_200, error: 'exit code 1' },
      { name: 'Write', status: 'failed', durationMs: 900 },
    ])
    const lines = line.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('exit code 1')
    // A failure with no reported reason still gets a row rather than vanishing.
    expect(lines[1]).toContain('Writing a file')
    expect(lines[1]).not.toContain(':')
  })

  it('renders no failure row when nothing failed', () => {
    expect(renderFailedTools([{ name: 'Read', status: 'completed' }])).toBe('')
    expect(renderFailedTools(undefined)).toBe('')
  })

  // The spinner must advance with the frame, or the line reads as a hang.
  it('advances the spinner with the frame', () => {
    const first = brailleSpinner(0)
    const second = brailleSpinner(1)
    expect(first).not.toBe(second)
    // Every frame is one fixed-width cell, so the line never shifts.
    for (let f = 0; f < 8; f++) expect([...brailleSpinner(f)]).toHaveLength(1)
    expect(brailleSpinner(8)).toBe(first)
  })

  // The ephemeral slot is activity-only. Model prose belongs in the real reply,
  // where it is durable and in order; in a slot overwritten every tick it
  // vanished mid-sentence. The type no longer even carries narration.
  it('renders activity only, never model prose', () => {
    const line = renderTurnActivity({ ...base, toolCalls: 1, currentTool: 'read_file' }, 0)
    expect(line).not.toContain('Let me')
  })
})

describe('formatToolDuration', () => {
  it('formats sub-second, seconds, and minutes', () => {
    expect(formatToolDuration(420)).toBe('0.4s')
    expect(formatToolDuration(1_200)).toBe('1.2s')
    expect(formatToolDuration(65_000)).toBe('1m 5s')
    expect(formatToolDuration(120_000)).toBe('2m')
  })

  // `(0s)` reads as a broken timer, so a genuinely instant tool says so.
  it('never renders a bare zero', () => {
    expect(formatToolDuration(0)).toBe('<0.1s')
    expect(formatToolDuration(40)).toBe('<0.1s')
  })

  it('renders nothing when the runner never measured a duration', () => {
    expect(formatToolDuration(undefined)).toBe('')
  })
})
