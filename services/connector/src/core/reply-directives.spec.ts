import { expect, it } from 'vitest'
import { parseReplyDirectives as parse, renderReplyReferences, replyMedia } from './reply-directives.js'
it('resolves only successful references, retaining unknown and missing paths', () => {
  const text = 'Report [[report/日报.pdf]] [[report/日报.pdf]] [[missing.png]] [[daily]]'
  const parsed = parse(text)
  expect(parsed.references.map(r => r.path)).toEqual(['report/日报.pdf', 'report/日报.pdf', 'missing.png'])
  expect(renderReplyReferences(text, parsed.references, new Set(['report/日报.pdf']))).toBe('Report   [[missing.png]] [[daily]]')
})
it('keeps code, escaped brackets and incomplete references literal', () => {
  // A code span that is NOT exactly one reference stays literal: a longer
  // snippet, a FENCED block, an escape, and an unfinished bracket are all
  // discussion rather than an attachment.
  for (const text of ['`example\n[[a.png]]`', '```text\n[[a.png]]\n```', '~~~\n[[no-reply]]\n~~~', '\\[[a.png]]', '[[unfinished.png']) {
    expect(parse(text)).toEqual({ references: [], silent: false })
  }
})
it('recovers a reference the model wrapped in a single code span', () => {
  // The reported bug: wrapping `[[path]]` in backticks left the brackets as
  // literal text, so the operator saw `[[a.png]]` instead of the image.
  const parsed = parse('Here it is: `[[a.png]]`')
  expect(parsed.references.map(r => r.path)).toEqual(['a.png'])
  expect(renderReplyReferences('Here it is: `[[a.png]]`', parsed.references, new Set(['a.png'])))
    .toBe('Here it is:')
})
it('rejects absolute paths, traversal, URLs and unknown extensions', () => {
  expect(parse('[[/tmp/a.png]] [[../a.png]] [[https://a/a.png]] [[file:a.png]] [[note|a.pdf]]').references).toEqual([])
})
it('recognizes silence without interpreting its source', () => {
  expect(parse('[[no-reply]] quiet').silent).toBe(true)
  expect(parse('`[[no-reply]]`').silent).toBe(false)
})
it('selects presentation by directory convention and file type', () => {
  expect(replyMedia('sticker/hello.webp')).toBe('sticker')
  expect(replyMedia('sticker/hello.png')).toBe('sticker')
  expect(replyMedia('report/chart.PNG')).toBe('image')
  expect(replyMedia('report/weekly.pdf')).toBe('file')
  expect(replyMedia('sticker/notes.txt')).toBe('file')
})
