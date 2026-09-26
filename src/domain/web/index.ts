/**
 * Web — Public exports
 *
 * Open-web access: multi-backend search (Python `ddgs`) + Jina-Reader page
 * fetch. Distinct from `news` (the subscribed-RSS archive).
 */

export { createWebSearchTools, webSearch, defaultDdgsRunner, ddgsScriptPath, hostnameOf, stripHighlightMarkup, WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_DEFAULT_RESULTS } from './search.js'
export type { WebSearchResponse, WebSearchResult, WebSearchSuccess, WebSearchFailure, WebSearchBackend, DdgsRunner, DdgsScriptResult } from './search.js'
export { createWebReaderTools, readUrl, validateReadUrl, extractJinaTitle, READ_URL_MAX_LENGTH } from './read-url.js'
export type { ReadUrlResponse, ReadUrlSuccess, ReadUrlFailure } from './read-url.js'
