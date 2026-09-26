/**
 * Web reader — fetch a URL as Markdown text via the Jina Reader API.
 *
 * Ported from Vibe-Trading's `read_url` tool. Jina Reader (`r.jina.ai`) turns
 * an arbitrary page into clean Markdown without a key. Like the search tool,
 * this never throws: a failure returns `status: "error"` so the caller can
 * report it honestly.
 *
 * Complements `webSearch`: search finds candidate URLs, this reads one in full.
 */

import { tool } from 'ai'
import { z } from 'zod'

const JINA_PREFIX = 'https://r.jina.ai/'
const TIMEOUT_MS = 30_000
/** Vibe truncated at 8000 chars; keep a bounded payload out of the agent context. */
export const READ_URL_MAX_LENGTH = 8_000

/** Strip credentials/scheme before handing a URL to the reader proxy, and
 *  reject non-http(s) targets (file:, data:, etc.). */
export function validateReadUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: `Not a valid absolute URL: ${raw}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Only http(s) URLs can be read (got ${parsed.protocol})` }
  }
  return { ok: true, url: parsed.toString() }
}

/** Extract the `Title:` line Jina prepends to its Markdown output. */
export function extractJinaTitle(markdown: string): string {
  for (const line of markdown.split('\n')) {
    if (line.startsWith('Title:')) return line.slice('Title:'.length).trim()
  }
  return ''
}

export interface ReadUrlSuccess {
  status: 'ok'
  title: string
  url: string
  content: string
  length: number
  truncated?: boolean
}

export interface ReadUrlFailure {
  status: 'error'
  error: string
}

export type ReadUrlResponse = ReadUrlSuccess | ReadUrlFailure

/**
 * Fetch a page as Markdown. Never throws — returns `status: "error"` on any
 * transport, timeout, or non-200 failure.
 */
export async function readUrl(
  rawUrl: string,
  options: { maxLength?: number; fetchImpl?: typeof fetch } = {},
): Promise<ReadUrlResponse> {
  const checked = validateReadUrl(rawUrl)
  if (!checked.ok) return { status: 'error', error: checked.error }

  const fetchImpl = options.fetchImpl ?? fetch
  const maxLength = options.maxLength ?? READ_URL_MAX_LENGTH
  try {
    const res = await fetchImpl(`${JINA_PREFIX}${checked.url}`, {
      headers: { Accept: 'text/markdown' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { status: 'error', error: `Jina Reader returned ${res.status}: ${body.slice(0, 500)}` }
    }
    const full = await res.text()
    const truncated = full.length > maxLength
    const content = truncated
      ? `${full.slice(0, maxLength)}\n\n... (truncated, total ${full.length} chars)`
      : full
    return {
      status: 'ok',
      title: extractJinaTitle(full),
      url: checked.url,
      content,
      length: full.length,
      ...(truncated ? { truncated: true } : {}),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: /abort|timeout/i.test(message) ? `Request timed out (${TIMEOUT_MS / 1000}s)` : message }
  }
}

// ==================== AI Tool factory ====================

export function createWebReaderTools() {
  return {
    readUrl: tool({
      description: `Fetch a web page and return its content as Markdown text.

Use after webSearch to read a specific result in full — docs, articles, API
references. The page is rendered to Markdown by the Jina Reader service, so you
get readable text instead of raw HTML.

Long pages are truncated to ${READ_URL_MAX_LENGTH} chars; the result reports
the full length. On failure returns \`{ status: "error", error: ... }\`.

Example: readUrl({ url: "https://example.com/article" })`,
      inputSchema: z.object({
        url: z.string().describe('Absolute http(s) URL of the page to read'),
      }).meta({ examples: [{ url: 'https://example.com/article' }] }),
      execute: async ({ url }) => readUrl(url),
    }),
  }
}
