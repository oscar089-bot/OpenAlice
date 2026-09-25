import { describe, expect, it } from 'vitest'

import {
  activityBar,
  brailleSpinner,
  describeToolActivity,
  describeToolCounts,
  formatToolDuration,
  renderTurnActivity,
  toolChannel,
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

describe('activityBar', () => {
  it('advances with the frame and never overruns the width', () => {
    const first = activityBar(0, 8)
    const second = activityBar(1, 8)
    expect(first).not.toBe(second)
    // Brackets are chrome, so the CELL count is width; total length is width+2.
    for (const frame of [0, 3, 7, 8, 99]) {
      expect(activityBar(frame, 8)).toHaveLength(10)
    }
  })

  // This is a PULSE, not a progress meter: it sweeps to full and resets, which
  // is what makes a long single tool call read as alive instead of frozen. The
  // headline text is what says the turn is unfinished.
  it('sweeps to full then resets, rather than behaving like a progress meter', () => {
    expect(activityBar(0, 12)).toBe('[' + '\u2592' + '\u2591'.repeat(11) + ']')
    expect(activityBar(11, 12)).toBe('[' + '\u2592'.repeat(12) + ']')
    expect(activityBar(12, 12)).toBe('[' + '\u2592' + '\u2591'.repeat(11) + ']')
  })
})

describe('describeToolCounts', () => {
  it('stays empty before the first tool call', () => {
    expect(describeToolCounts(base)).toBe('')
  })

  it('singularizes and reports failures', () => {
    expect(describeToolCounts({ ...base, toolCalls: 1 })).toBe('1 tool')
    expect(describeToolCounts({ ...base, toolCalls: 3 })).toBe('3 tools')
    expect(describeToolCounts({ ...base, toolCalls: 3, toolFailures: 1 })).toBe('3 tools \u00B7 1 failed')
  })
})

describe('renderTurnActivity', () => {
  it('leads with a braille spinner and names the running tool\u2019s channel', () => {
    const line = renderTurnActivity({ ...base, toolCalls: 1, currentTool: 'read_file' }, 0)
    expect(line).toContain('\u28FE')
    expect(line).toContain('alice@{read}:~$')
    expect(line).toContain('Running\u2026')
  })

  it('uses the shell channel for a bash tool', () => {
    const line = renderTurnActivity({ ...base, toolCalls: 1, currentTool: 'Bash' }, 0)
    expect(line).toContain('alice@{bash}:~$')
  })

  it('shows thinking before any tool has run', () => {
    const line = renderTurnActivity(base, 0)
    expect(line).toContain('Thinking\u2026')
    expect(line).not.toContain('Running')
  })

  // The tool COUNT must ride the FIRST line.
  //
  // Before any tool runs the slot is ONLY the spinner.
  //
  // No bar, no counters, no empty "Recent activity" scaffolding — exactly like
  // the Discord surface, which stayed quiet until the model actually did
  // something. A gauge that is drawn before there is anything to gauge is
  // noise, and it made an idle turn look busier than it was.
  it('shows only the spinner before the first tool call', () => {
    expect(renderTurnActivity(base, 0)).toBe(`${brailleSpinner(0)} \uD83E\uDDE0 Thinking\u2026`)
  })

  // Once a tool HAS run, the bar and counts appear — including between tools,
  // because a fast Read can finish before the next publish and "Thinking"
  // alone would hide the evidence that work already happened.
  it('adds the bar and counts once a tool has run', () => {
    const line = renderTurnActivity({ ...base, toolCalls: 2 }, 0)
    const [first = '', second = ''] = line.split('\n')
    expect(first).toContain('Thinking\u2026')
    expect(second).toContain('2 tools')
  })

  // The tool log is the point of the readout: each call, in order, with its
  // real outcome. A bare count could not answer WHICH tool ran or why one
  // failed.
  it('lists the tool calls the model ran', () => {
    const line = renderTurnActivity({
      ...base,
      toolCalls: 3,
      toolFailures: 1,
      recentTools: [
        { name: 'Read', status: 'completed', durationMs: 420 },
        { name: 'Bash', status: 'failed', durationMs: 1_200, error: 'exit code 1' },
        { name: 'Write', status: 'running' },
      ],
    }, 0)
    const lines = line.split('\n')
    expect(lines[2]).toContain('Reading a file')
    expect(lines[3]).toContain('Running a command')
    expect(lines[4]).toContain('Writing a file')
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

  it('lists recent tools with status, duration, and a failure reason', () => {
    const line = renderTurnActivity({
      ...base,
      toolCalls: 3,
      toolFailures: 1,
      recentTools: [
        { name: 'Read', status: 'completed', durationMs: 420 },
        { name: 'Bash', status: 'failed', durationMs: 1_200, error: 'exit code 1' },
        { name: 'Write', status: 'running' },
      ],
    }, 0)
    expect(line).toContain('\u2705 Reading a file (0.4s)')
    expect(line).toContain('\u26A0\uFE0F Running a command (1.2s): exit code 1')
    // A running row animates: a frozen mark on the row you actually stare at
    // while a long command blocks the turn reads as a hung process.
    expect(line).toContain(`${brailleSpinner(0)} Writing a file`)
    expect(line).toContain('3 tools \u00B7 1 failed')
    // A running tool has no duration yet \u2014 claiming one would be a lie.
    expect(line).not.toContain('Writing a file (')
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

describe('toolChannel', () => {
  it('maps tool families to a prompt channel', () => {
    expect(toolChannel('Bash')).toBe('bash')
    expect(toolChannel('Read')).toBe('read')
    expect(toolChannel('grep_search')).toBe('grep')
    expect(toolChannel('run_in_terminal')).toBe('bash')
  })

  it('falls back to a readable channel rather than hiding an unknown tool', () => {
    expect(toolChannel('some_new_tool')).toBe('some')
    expect(toolChannel(undefined)).toBe('alice')
  })
})
