import { describe, expect, it } from 'vitest'
import { inboxFiles, parseContentReferences, parseMarketReference } from './content-references.js'

describe('shared content references', () => {
  it('retains source offsets/order while deriving a unique file index', () => {
    const body = 'Before [[reports/Case.PDF]] middle [[images/photo.png]] after [[reports/Case.PDF]]'
    const { references } = parseContentReferences(body)
    expect(references.map(ref => body.slice(ref.start, ref.end))).toEqual(['[[reports/Case.PDF]]', '[[images/photo.png]]', '[[reports/Case.PDF]]'])
    expect(inboxFiles({ body, fileRevisions: { 'reports/Case.PDF': 'sha256:abc' } })).toEqual([{ path: 'reports/Case.PDF', revision: 'sha256:abc' }, { path: 'images/photo.png' }])
  })
  it('recovers a real reference the model wrapped in an inline code span', () => {
    // The reported bug: a backticked `[[path]]` stayed literal, so the operator
    // saw `[[reports/chart.png]]` instead of the image. A span that is EXACTLY
    // one valid reference is now recovered.
    const body = 'Here it is: `[[reports/chart.png]]`'
    expect(parseContentReferences(body).references.map(ref => body.slice(ref.start, ref.end)))
      .toEqual(['`[[reports/chart.png]]`'])
    expect(inboxFiles({ body })).toEqual([{ path: 'reports/chart.png' }])
  })

  it('ignores code that is not a reference, plus escapes, entities and escaping paths', () => {
    // A bare placeholder, a FENCED example, an escape, an entity link, and a
    // path leaving the Workspace are all discussion, not attachments.
    const body = '`[[path]]`\n```md\n[[fenced.md]]\n```\n\\[[escaped.md]] [[NVDA]] [[../private.md]] [[/absolute.pdf]] [[https://example.com/a.pdf]] [[./README]]'
    expect(inboxFiles({ body })).toEqual([{ path: './README' }])
  })
  it('does not turn Inbox no-reply into content removal', () => {
    expect(inboxFiles({ body: '[[no-reply]] text [[a.pdf]]' })).toEqual([{ path: 'a.pdf' }])
  })
})

it('parses market identities at the last slash without indexing them as files', () => {
  const path = 'market/okx|BTC/USDT:USDT/4h'
  expect(parseMarketReference(path)).toEqual({ barId: 'okx|BTC/USDT:USDT', interval: '4h' })
  const body = `Before [[${path}]] after [[report.pdf]]`
  expect(parseContentReferences(body).references.map(ref => body.slice(ref.start, ref.end))).toEqual([`[[${path}]]`, '[[report.pdf]]'])
  expect(inboxFiles({ body })).toEqual([{ path: 'report.pdf' }])
  for (const invalid of ['market/foo/1d', 'market/a|b/2m', 'market/|b/1d', 'market/a|/1d']) {
    expect(parseMarketReference(invalid)).toBeNull()
    expect(parseContentReferences(`[[${invalid}]]`).references).toEqual([])
  }
  // A backticked market identity is still a real chart request.
  expect(parseContentReferences('`[[market/a|b/1d]]`').references.map(ref => ref.path)).toEqual(['market/a|b/1d'])

  // The exact identity from the report, in both spellings. A market reference
  // contains `|` and `/`, so it fails `isFileReference` and must be recognised
  // as a chart request by `parseMarketReference` instead.
  for (const body of ['[[market/yfinance|SOLUSD/1d]]', '`[[market/yfinance|SOLUSD/1d]]`']) {
    expect(parseContentReferences(body).references.map(ref => ref.path))
      .toEqual(['market/yfinance|SOLUSD/1d'])
  }
})
