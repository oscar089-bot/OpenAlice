import { describe, expect, it } from 'vitest'

import { renderTurnActivity } from '@traderalice/connector-protocol'

import { claudeAdapter } from './adapters/claude.js'
import { HeadlessOutputAccumulator } from './headless-output.js'
import { projectTurnProgress } from './headless-progress.js'
import { turnActivityFrom } from './issues/telegram-desk-project.js'

// Realistic Claude Code JSONL: assistant tool_use, then user tool_result.
const LINES = [
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'Let me look at the evaluator.' },
    { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
  ] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' },
  ] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
  ] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu_2', is_error: true, content: 'boom' },
  ] } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu_3', name: 'Write', input: { file_path: 'b.ts' } },
  ] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu_3', content: 'ok' },
  ] } }),
]

describe('end-to-end activity pipeline', () => {
  it('turns a real Claude tool stream into a truthful activity line', () => {
    const acc = new HeadlessOutputAccumulator()
    for (const line of LINES) {
      acc.add(claudeAdapter.extractHeadlessOutputEvents?.(line) ?? [])
    }
    const structured = acc.snapshot(true)

    // The runner must have paired start/finish into three tools, one failed.
    expect(structured.blocks.map((b) => (b.type === 'tool' ? `${b.name}:${b.status}` : b.type)))
      .toEqual(['text', 'Read:completed', 'Bash:failed', 'Write:completed'])
    expect(structured.metrics).toMatchObject({ toolCalls: 3, toolFailures: 1 })

    const activity = turnActivityFrom(projectTurnProgress(structured))
    expect(activity).toBeDefined()
    expect(activity?.toolCalls).toBe(3)
    expect(activity?.toolFailures).toBe(1)
    // All three calls are visible, with their real outcome. A fixed clock
    // yields no measurable duration here, which is correct: duration is
    // wall-clock and belongs to its own test, while the failure reason is
    // pinned because "1 failed" without a reason was the old readout's flaw.
    expect(activity?.recentTools).toEqual([
      { name: 'Read', status: 'completed' },
      { name: 'Bash', status: 'failed', error: 'boom' },
      { name: 'Write', status: 'completed' },
    ])

    const line = renderTurnActivity(activity!, 2)
    console.log('\n--- rendered activity ---\n' + line + '\n------------------------')
    expect(line).toContain('\u2705 Reading a file')
    expect(line).toContain('\u26A0\uFE0F Running a command')
    expect(line).toContain('\u2705 Writing a file')
    expect(line).toContain('3 tools \u00B7 1 failed')
    // Prose must NOT appear.
    expect(line).not.toContain('Let me look at the evaluator.')
  })
})
