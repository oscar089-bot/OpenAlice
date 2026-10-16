/**
 * Telegram watcher board — pure logic.
 *
 * A single, on-demand, edited-in-place message that pages through the live
 * watchers one at a time. Nothing here touches the network or a clock: the
 * adapter owns the bot, the item list, and persistence, so this module stays
 * testable without a Telegram connection.
 *
 * Content layout is NOT re-implemented here. It comes from the shared
 * `renderWatcherBoardCard` in `@traderalice/connector-protocol`, the same
 * renderer Discord uses. That keeps the phone board and the desktop board from
 * disagreeing about what a watcher's progress means. This module adds only the
 * Telegram chrome (header, pager, buttons) and converts the renderer's small
 * Markdown subset into Telegram HTML.
 *
 * Why HTML rather than MarkdownV2: the renderer emits prices, percentages and
 * zone ranges like `62,900-63,250`. MarkdownV2 requires escaping `.`, `-`,
 * `(`, `)` and more, and every unescaped one is a hard 400 from Telegram. HTML
 * only needs `&`, `<` and `>`, so the whole class of failure disappears.
 */

import type { WatcherBoardItem } from '@traderalice/connector-protocol'
import { renderWatcherBoardCard } from '@traderalice/connector-protocol'

/** Telegram's text limit. Kept below it so an edit never fails the send. */
export const TELEGRAM_BOARD_TEXT_MAX = 4000

export interface TelegramBoardAction {
  text: string
  data: string
}

/** Callback data. Deliberately tiny: watcher ids reach 64 chars and Telegram
 *  caps callback data at 64, so ids never travel in the payload. There is
 *  exactly one board message, so its id already identifies the session. */
const TELEGRAM_WATCH_PREFIX = 'wb:'
const CONTROL_NEXT = `${TELEGRAM_WATCH_PREFIX}n`
const CONTROL_PREV = `${TELEGRAM_WATCH_PREFIX}p`
const CONTROL_TOGGLE = `${TELEGRAM_WATCH_PREFIX}t`
const CONTROL_DELETE = `${TELEGRAM_WATCH_PREFIX}d`
const CONTROL_CLOSE = `${TELEGRAM_WATCH_PREFIX}x`

export type TelegramWatchControl =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'toggle' }
  | { kind: 'delete' }
  | { kind: 'close' }

/** Parse a callback payload. `undefined` means "not ours", so the adapter can
 *  fall through to the Inbox/UTA controls instead of swallowing the press. */
export function parseTelegramWatchControl(data: string): TelegramWatchControl | undefined {
  switch (data) {
    case CONTROL_NEXT: return { kind: 'next' }
    case CONTROL_PREV: return { kind: 'prev' }
    case CONTROL_TOGGLE: return { kind: 'toggle' }
    case CONTROL_DELETE: return { kind: 'delete' }
    case CONTROL_CLOSE: return { kind: 'close' }
    default: return undefined
  }
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Convert the shared renderer's Markdown subset to Telegram HTML.
 *
 * The renderer only emits `**bold**` and `` `code` `` plus plain prose, so this
 * is a total function over that subset rather than a general parser. Escaping
 * happens FIRST so a `<` in watcher content cannot inject a tag.
 */
export function toTelegramBoardHtml(markdown: string): string {
  return escapeTelegramHtml(markdown)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
}

/** Clamp a pager index into range. An empty board reports 0. */
export function clampBoardIndex(index: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(index) || index < 0) return 0
  if (index > count - 1) return count - 1
  return Math.floor(index)
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}\u2026`
}

export interface TelegramBoardSessionState {
  /** Which watcher the pager shows. */
  index: number
  /** watcherIds whose detail panel is open. */
  expanded: ReadonlySet<string>
}

export interface TelegramWatcherBoardInput extends TelegramBoardSessionState {
  items: WatcherBoardItem[]
  frame: number
  nowIso: string
  refreshSeconds: number
}

export interface TelegramWatcherBoardForm {
  html: string
  actions: TelegramBoardAction[][]
  /** The index actually rendered, after clamping. The caller persists THIS. */
  index: number
}

/**
 * Build the whole board message: header, the current watcher's card (or card +
 * detail), and the button rows.
 *
 * Pure and total. An empty board renders an explicit "no watchers armed" state
 * with only a Close button, rather than a half-drawn pager with dead arrows.
 */
export function formatTelegramWatcherBoard(
  input: TelegramWatcherBoardInput,
): TelegramWatcherBoardForm {
  const { items, frame, nowIso, expanded } = input
  if (items.length === 0) {
    return {
      html: [
        '\uD83D\uDC41 <b>Watcher Board</b> \u00b7 no watchers armed',
        '',
        'Arm a watcher in OpenAlice and it appears here on the next tick.',
      ].join('\n'),
      actions: [[{ text: '\u2716 Close', data: CONTROL_CLOSE }]],
      index: 0,
    }
  }

  const index = clampBoardIndex(input.index, items.length)
  const item = items[index] as WatcherBoardItem
  const isExpanded = expanded.has(item.watcherId)
  const rendered = renderWatcherBoardCard(item, frame)
  const clock = nowIso.length >= 19 ? nowIso.slice(11, 19) : ''

  // The header carries the pager position, not a per-watcher line, so the
  // operator always knows where they are in the list.
  const header = [
    `\uD83D\uDC41 <b>Watcher Board</b> \u00b7 ${index + 1} of ${items.length}`,
    clock ? ` \u00b7 ${clock} UTC` : '',
    ` \u00b7 refresh ${input.refreshSeconds}s`,
  ].join('')

  // Expanded replaces the compact card with the full detail panel; it never
  // renders both, which would repeat the header/status lines above the detail.
  const body = isExpanded ? rendered.detail : rendered.card
  const html = truncate([header, '', toTelegramBoardHtml(body)].join('\n'), TELEGRAM_BOARD_TEXT_MAX)

  // Previous only exists past the first watcher, Next only before the last, so
  // Telegram never renders a row with a dead arrow in it.
  const pager: TelegramBoardAction[] = []
  if (index > 0) pager.push({ text: '\u25C0 Previous', data: CONTROL_PREV })
  if (index < items.length - 1) pager.push({ text: 'Next \u25B6', data: CONTROL_NEXT })

  const actions: TelegramBoardAction[][] = [[
    {
      text: isExpanded ? '\uD83D\uDD3C Collapse' : '\uD83D\uDD0E Details',
      data: CONTROL_TOGGLE,
    },
    { text: '\uD83D\uDDD1 Delete', data: CONTROL_DELETE },
    { text: '\u2716 Close', data: CONTROL_CLOSE },
  ]]
  if (pager.length > 0) actions.push(pager)

  return { html, actions, index }
}

/** Toggle one watcher's detail panel, returning the NEXT expanded set. */
export function toggleExpanded(
  expanded: ReadonlySet<string>,
  watcherId: string,
): Set<string> {
  const next = new Set(expanded)
  if (next.has(watcherId)) next.delete(watcherId)
  else next.add(watcherId)
  return next
}
