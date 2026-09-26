import { describe, it, expect, vi } from 'vitest'
import { webSearch, stripHighlightMarkup, hostnameOf, type DdgsRunner } from './search'
import { readUrl, validateReadUrl, extractJinaTitle, READ_URL_MAX_LENGTH } from './read-url'

const okRunner = (payload: unknown): DdgsRunner => vi.fn(async () => payload as never)

describe('stripHighlightMarkup', () => {
  it('removes bold highlight tags some backends leave in snippets', () => {
    expect(stripHighlightMarkup('the <b>BTC</b> price is <b>up</b>')).toBe('the BTC price is up')
  })

  it('is case-insensitive and trims', () => {
    expect(stripHighlightMarkup('  <B>x</B>  ')).toBe('x')
  })

  it('leaves text without markup untouched', () => {
    expect(stripHighlightMarkup('plain text')).toBe('plain text')
  })
})

describe('hostnameOf', () => {
  it('returns the hostname for a valid url and empty for garbage', () => {
    expect(hostnameOf('https://a.com/x')).toBe('a.com')
    expect(hostnameOf('not a url')).toBe('')
  })
})

describe('webSearch', () => {
  it('returns ok with normalized results and the winning backend', async () => {
    const runner = okRunner({
      status: 'ok',
      backend: 'brave',
      results: [
        { title: 'A <b>T</b>', url: 'https://a.com/1', snippet: 's <b>x</b>' },
        { title: 'B', url: 'https://b.com/2', snippet: 'y' },
      ],
    })
    const res = await webSearch('btc', { runner })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.backend).toBe('brave')
    expect(res.results[0]).toEqual({ title: 'A T', url: 'https://a.com/1', snippet: 's x', hostname: 'a.com' })
  })

  it('caps results at the hard ceiling', async () => {
    const runner = okRunner({
      status: 'ok',
      backend: 'bing',
      results: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://h${i}.com`, snippet: 's' })),
    })
    const res = await webSearch('x', { maxResults: 999, runner })
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.results).toHaveLength(10)
  })

  it('drops results without a usable url', async () => {
    const runner = okRunner({
      status: 'ok',
      backend: 'google',
      results: [{ title: 'no url' }, { title: 'ok', url: 'https://a.com' }],
    })
    const res = await webSearch('x', { runner })
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.results).toHaveLength(1)
    expect(res.results[0].url).toBe('https://a.com')
  })

  it('returns an error payload when every backend fails', async () => {
    const runner = okRunner({ status: 'error', error: 'brave: no results; bing: blocked' })
    const res = await webSearch('btc', { runner })
    expect(res).toEqual({ status: 'error', error: 'brave: no results; bing: blocked' })
  })

  it('returns an error when the helper reports ok but with no results', async () => {
    const runner = okRunner({ status: 'ok', backend: 'brave', results: [] })
    const res = await webSearch('btc', { runner })
    expect(res.status).toBe('error')
  })

  it('passes the timelimit through to the runner', async () => {
    const runner = okRunner({ status: 'ok', backend: 'brave', results: [{ url: 'https://a.com' }] })
    await webSearch('btc', { timelimit: 'd', runner })
    expect(runner).toHaveBeenCalledWith('btc', 5, 'd')
  })
})

describe('validateReadUrl', () => {
  it('accepts http and https', () => {
    expect(validateReadUrl('https://example.com/a')).toEqual({ ok: true, url: 'https://example.com/a' })
    expect(validateReadUrl('http://example.com')).toEqual({ ok: true, url: 'http://example.com/' })
  })

  it('rejects non-http(s) schemes (file:, data:, javascript:)', () => {
    for (const u of ['file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)']) {
      const res = validateReadUrl(u)
      expect(res.ok, u).toBe(false)
    }
  })

  it('rejects relative / invalid URLs', () => {
    expect(validateReadUrl('/relative').ok).toBe(false)
    expect(validateReadUrl('not a url').ok).toBe(false)
  })
})

describe('extractJinaTitle', () => {
  it('pulls the Title: line from Jina markdown', () => {
    expect(extractJinaTitle('Title: Hello World\nMarkdown Content')).toBe('Hello World')
  })

  it('returns empty when there is no Title line', () => {
    expect(extractJinaTitle('just content')).toBe('')
  })
})

describe('readUrl', () => {
  const okFetch = (body: string, init?: { status?: number }) => vi.fn(async () => ({
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    text: async () => body,
  })) as unknown as typeof fetch

  it('returns markdown content and the extracted title', async () => {
    const res = await readUrl('https://example.com', { fetchImpl: okFetch('Title: Ex\n# Body') })
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.title).toBe('Ex')
    expect(res.content).toContain('# Body')
    expect(res.url).toBe('https://example.com/')
  })

  it('truncates long content and reports the full length', async () => {
    const long = 'a'.repeat(READ_URL_MAX_LENGTH + 500)
    const res = await readUrl('https://example.com', { fetchImpl: okFetch(long) })
    if (res.status !== 'ok') throw new Error('expected ok')
    expect(res.content).toContain('truncated')
    expect(res.length).toBe(long.length)
    expect(res.truncated).toBe(true)
  })

  it('returns an error payload on a non-2xx response', async () => {
    const res = await readUrl('https://example.com', { fetchImpl: okFetch('nope', { status: 503 }) })
    expect(res.status).toBe('error')
  })

  it('rejects an invalid URL without calling fetch', async () => {
    const spy = okFetch('x')
    const res = await readUrl('file:///etc/passwd', { fetchImpl: spy })
    expect(res.status).toBe('error')
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns an error payload instead of throwing on transport failure', async () => {
    const failing = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    const res = await readUrl('https://example.com', { fetchImpl: failing })
    expect(res).toEqual({ status: 'error', error: 'network down' })
  })

  it('maps an abort/timeout to a friendly message', async () => {
    const failing = vi.fn(async () => { throw new Error('This operation was aborted') }) as unknown as typeof fetch
    const res = await readUrl('https://example.com', { fetchImpl: failing })
    expect(res).toEqual({ status: 'error', error: 'Request timed out (30s)' })
  })
})
