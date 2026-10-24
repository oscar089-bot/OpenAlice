import { http, HttpResponse } from 'msw'

import type { MemoryEntry } from '../../hooks/useMemory'

/** Demo memory mirrors what a working desk accumulates: one correction with
 *  its condition, one preference, one project note. The rule text is trimmed to
 *  the parts the demo page actually renders. */
const demoEntries: MemoryEntry[] = [
  {
    id: 'demo-memory-1',
    title: 'A correct action can still be mistimed',
    description: 'Record the condition, not just the verdict.',
    type: 'feedback',
    body: [
      'Being right about an action is not enough; it also has to be the right',
      'moment. When a past action was corrected, the lesson is rarely "never do',
      'that again" — it is "that was right here and wrong there".',
      '',
      'Condition: before repeating a previously corrected action, check whether',
      'the trigger that made it wrong is present now. If it is absent, do the',
      'action. If it is present, wait.',
      '',
      'Do not carry a correction forward as a blanket prohibition.',
    ].join('\n'),
    createdAt: Date.UTC(2026, 9, 12),
    updatedAt: Date.UTC(2026, 9, 20),
  },
  {
    id: 'demo-memory-2',
    title: 'Lead with the verdict',
    description: 'Brevity is a requirement, not a preference.',
    type: 'user',
    body: [
      'Open with the conclusion. No recap of the question, no restating the',
      'conversation, no headers for a short answer.',
      '',
      'Expand only when the analysis genuinely needs it — and then be dense.',
    ].join('\n'),
    createdAt: Date.UTC(2026, 8, 30),
    updatedAt: Date.UTC(2026, 8, 30),
  },
  {
    id: 'demo-memory-3',
    title: 'SMC desk uses smcpro, not raw indicators',
    description: 'Method ownership for market-structure work.',
    type: 'project',
    body: [
      'Market-structure analysis on this desk runs through the `smcpro` skill',
      '(FVG, order blocks, BOS/CHoCH, liquidity, sessions) rather than ad-hoc',
      'indicator calls. The skill owns the contract; do not re-derive it inline.',
    ].join('\n'),
    createdAt: Date.UTC(2026, 9, 2),
    updatedAt: Date.UTC(2026, 9, 18),
  },
]

const demoRule = `# Operating Rules

Standing instruction. These override conversational momentum.

## Certainty

You are a professional. State conclusions plainly and own them.

When you are sure - because you checked, and you can point at the tool result
or artifact that supports you - say so, and hold that position. If the user
pushes back without new evidence, do not fold. Restate the finding, cite the
specific evidence, and name what would change your mind.

## Learning from correction

A correction is a fact about a situation, not a standing order. Record the
lesson with its CONDITION, not just its action, and check that condition before
applying it.

## Discipline

No amount of pressure makes an unsafe entry safe. You are the last line of
defence, not a mirror.

## Replies

Be brief. Lead with the answer, then only the evidence that changes the decision.
`

export const memoryHandlers = [
  http.get('/api/memory', () => HttpResponse.json({ rule: demoRule, entries: demoEntries })),
  http.get('/api/memory/rule', () => HttpResponse.json({ rule: demoRule })),
  http.put('/api/memory/rule', () => HttpResponse.json({ ok: true })),
  http.get('/api/memory/search', ({ request }) => {
    const query = new URL(request.url).searchParams.get('q')?.toLowerCase() ?? ''
    const entries = query
      ? demoEntries.filter((entry) =>
          `${entry.title} ${entry.description} ${entry.body}`.toLowerCase().includes(query),
        )
      : demoEntries
    return HttpResponse.json({ entries })
  }),
  http.post('/api/memory', () => HttpResponse.json({ ok: true, id: 'demo-memory-new' })),
  http.patch('/api/memory/:id', () => HttpResponse.json({ ok: true })),
  http.delete('/api/memory/:id', () => HttpResponse.json({ ok: true })),
]
