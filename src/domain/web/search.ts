/**
 * Web search — multi-backend search via the Python `ddgs` package.
 *
 * Ported from Vibe-Trading's `web_search` tool. Vibe's durability came from
 * `ddgs` trying several backends: DuckDuckGo's own endpoint is frequently
 * rate-limited from datacenter IPs ("anomaly in the request") while brave /
 * bing / google / yahoo still answer. Verified live on this host — the Node
 * `duck-duck-scrape` package only talks to the blocked DDG endpoint, so we
 * delegate to the same Python backend-fallback Vibe used.
 *
 * The tool never throws on a search failure — it returns a structured
 * `status: "error"` payload so an agent can declare `WEB SEARCH STATUS: FAILED`
 * instead of silently pretending it searched.
 *
 * This is OPEN-WEB coverage. It is a different surface from `rss` (the user's
 * subscribed feed archive) — do not conflate the two in agent guidance.
 */

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { appResourcesHome } from '../../core/paths.js'

/** Vibe capped results at 10; keep the same ceiling. */
export const WEB_SEARCH_MAX_RESULTS = 10
export const WEB_SEARCH_DEFAULT_RESULTS = 5

/** Path to the backend-fallback helper script. */
export function ddgsScriptPath(): string {
  return resolve(appResourcesHome, 'src', 'domain', 'web', 'ddgs-search.py')
}

/**
 * Which search backend served a result.
 *
 * Backends are tried in order because DuckDuckGo's own endpoint is frequently
 * rate-limited from datacenter IPs while the others still answer. Reporting the
 * backend lets the agent state what it actually got.
 */
export type WebSearchBackend = string

/** A single normalized web result. */
export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  hostname: string
}

export interface WebSearchSuccess {
  status: 'ok'
  query: string
  /** Which backend answered (e.g. `brave`, `bing`). Reported so the caller can
   *  state its actual source instead of a generic "web". */
  backend: WebSearchBackend
  results: WebSearchResult[]
}

export interface WebSearchFailure {
  status: 'error'
  error: string
}

export type WebSearchResponse = WebSearchSuccess | WebSearchFailure

/** Strip the `<b>`/`</b>` highlight markup some backends leave in snippets. */
export function stripHighlightMarkup(text: string): string {
  return text.replace(/<\/?b>/gi, '').trim()
}

/** Extract a bare hostname from a result URL (empty string when unparseable). */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Shape returned by the Python helper script on stdout. */
export interface DdgsScriptResult {
  status: 'ok' | 'error' | 'unavailable'
  backend?: string
  results?: { title?: string; url?: string; snippet?: string }[]
  error?: string
}

/** Injectable runner so tests never spawn a process. */
export type DdgsRunner = (query: string, maxResults: number, timelimit: string) => Promise<DdgsScriptResult>

/** Default runner: spawn `python3 ddgs-search.py <query> <max> <timelimit>`. */
export const defaultDdgsRunner: DdgsRunner = (query, maxResults, timelimit) =>
  new Promise((resolveResult) => {
    execFile(
      'python3',
      [ddgsScriptPath(), query, String(maxResults), timelimit],
      { timeout: 45_000, maxBuffer: 1_000_000 },
      (error, stdout) => {
        if (error && !stdout) {
          resolveResult({ status: 'error', error: error.message })
          return
        }
        try {
          resolveResult(JSON.parse(stdout) as DdgsScriptResult)
        } catch {
          resolveResult({ status: 'error', error: `unparseable search output: ${stdout.slice(0, 200)}` })
        }
      },
    )
  })

/**
 * Run a web search across backends. Never throws: returns `status: "error"` when
 * every backend fails, so the caller can report failure honestly.
 */
export async function webSearch(
  query: string,
  options: { maxResults?: number; timelimit?: string; runner?: DdgsRunner } = {},
): Promise<WebSearchResponse> {
  const maxResults = Math.min(Math.max(options.maxResults ?? WEB_SEARCH_DEFAULT_RESULTS, 1), WEB_SEARCH_MAX_RESULTS)
  const runner = options.runner ?? defaultDdgsRunner
  const result = await runner(query, maxResults, options.timelimit ?? '-')
  if (result.status !== 'ok' || !result.results?.length) {
    return { status: 'error', error: result.error ?? 'no backend returned results' }
  }
  const results = result.results
    .map((r) => ({
      title: stripHighlightMarkup(r.title ?? ''),
      url: r.url ?? '',
      snippet: stripHighlightMarkup(r.snippet ?? ''),
      hostname: hostnameOf(r.url ?? ''),
    }))
    .filter((r) => r.url)
    .slice(0, maxResults)
  if (results.length === 0) return { status: 'error', error: 'no usable results' }
  return { status: 'ok', query, backend: result.backend ?? 'unknown', results }
}

// ==================== AI Tool factory ====================

/** Maps the tool's coarse `time` argument to ddgs' time limit. */
const TIME_RANGES = {
  day: 'd',
  week: 'w',
  month: 'm',
  year: 'y',
} as const

export function createWebSearchTools() {
  return {
    webSearch: tool({
      description: `Search the OPEN WEB and return top results with title, URL, and snippet.

Use this for current events, news, prices, and anything that happened recently —
coverage is the whole web, not a fixed feed list. Pair it with readUrl to read a
result in full.

Search runs across several backends (brave, bing, google, yahoo, duckduckgo…) and
reports which one answered as \`backend\`. It can still fail transiently; on
failure it returns \`{ status: "error", error: ... }\` — report that honestly
(for example \`WEB SEARCH STATUS: FAILED — <reason>\`); never claim you searched
when you did not.

Unlike \`globRss\`/\`grepRss\` (which search ONLY the user's subscribed feeds),
this searches the open web. Use \`rss\` for the user's own feed archive and this
for general coverage.

Example: webSearch({ query: "BTC news today", time: "day", maxResults: 5 })`,
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().int().positive().max(WEB_SEARCH_MAX_RESULTS).optional()
          .describe(`Maximum number of results to return (default ${WEB_SEARCH_DEFAULT_RESULTS}, max ${WEB_SEARCH_MAX_RESULTS})`),
        time: z.enum(['day', 'week', 'month', 'year']).optional()
          .describe('Restrict results to a recent time range. Omit for any time.'),
      }).meta({ examples: [{ query: 'BTC news today', time: 'day', maxResults: 5 }] }),
      execute: async ({ query, maxResults, time }) => {
        return webSearch(query, { maxResults, ...(time ? { timelimit: TIME_RANGES[time] } : {}) })
      },
    }),
  }
}
