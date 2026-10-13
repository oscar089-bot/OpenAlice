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
    // The Bash failure was followed by a successful Write, so the turn
    // recovered. A recovered failure is no longer a live condition: it leaves
    // the readout instead of lingering until eight newer calls evict it.
    expect(activity?.toolFailures).toBe(0)
    expect(activity?.recentTools).toEqual([
      { name: 'Read', status: 'completed' },
      { name: 'Write', status: 'completed' },
    ])

    const line = renderTurnActivity(activity!, 2)
    // Successes are counted in the header meta, never listed as rows.
    expect(line).toContain('read write')
    expect(line).not.toContain('failed')
    expect(line).not.toContain('Running a command')
    // The model's latest COMPLETE narration rides the slot, between the header
    // and the tool meta. It is the sentence that says what the work is for, so
    // the activity line reads as progress rather than a bare counter.
    expect(line.split('\n')[1]).toBe('Let me look at the evaluator.')
  })

  it('keeps an unresolved failure visible until a later call succeeds', () => {
    // Same stream, but the turn ENDS on the failure — nothing recovered it, so
    // the warning and the failure count must both still be shown.
    const acc = new HeadlessOutputAccumulator()
    for (const line of LINES.slice(0, 4)) {
      acc.add(claudeAdapter.extractHeadlessOutputEvents?.(line) ?? [])
    }
    const structured = acc.snapshot(true)
    const activity = turnActivityFrom(projectTurnProgress(structured))

    expect(activity?.toolFailures).toBe(1)
    const line = renderTurnActivity(activity!, 2)
    expect(line).toContain('Running a command')
    expect(line).toContain('boom')
  })
})
