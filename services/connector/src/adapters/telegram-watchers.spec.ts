import { describe, expect, it } from 'vitest'

import type { WatcherBoardItem } from '@traderalice/connector-protocol'

import {
  clampBoardIndex,
  escapeTelegramHtml,
  formatTelegramWatcherBoard,
  parseTelegramWatchControl,
  toTelegramBoardHtml,
  toggleExpanded,
} from './telegram-watchers.js'

const NOW = '2026-09-22T12:00:00.000Z'

function item(watcherId: string, pair: string): WatcherBoardItem {
  return {
    watcherId,
    workspaceId: 'chat-stable-maple-bridge',
    title: `${pair} setup`,
    running: true,
    pollable: true,
    pollSeconds: 5,
    spec: {
      pair,
      direction: 'LONG',
      timeframe: '15m',
      rules: [{ type: 'price_breaks_level', side: 'above', level: 110 }],
      invalidationRules: [],
      managementRules: [],
    },
    state: {
      lastChecked: NOW,
      lastPrice: 100,
      pollCount: 12,
      terminal: false,
    },
    nowIso: NOW,
  }
}

function board(overrides: Partial<Parameters<typeof formatTelegramWatcherBoard>[0]> = {}) {
  return formatTelegramWatcherBoard({
    items: [item('w-1', 'BTCUSDT'), item('w-2', 'ETHUSDT'), item('w-3', 'SOLUSDT')],
    index: 0,
    expanded: new Set<string>(),
    frame: 0,
    nowIso: NOW,
    refreshSeconds: 5,
    ...overrides,
  })
}

describe('telegram watch control payloads', () => {
  it('parses every control', () => {
    expect(parseTelegramWatchControl('wb:n')).toEqual({ kind: 'next' })
    expect(parseTelegramWatchControl('wb:p')).toEqual({ kind: 'prev' })
    expect(parseTelegramWatchControl('wb:t')).toEqual({ kind: 'toggle' })
    expect(parseTelegramWatchControl('wb:d')).toEqual({ kind: 'delete' })
    expect(parseTelegramWatchControl('wb:x')).toEqual({ kind: 'close' })
  })

  it('returns undefined for a foreign payload so the adapter can fall through', () => {
    expect(parseTelegramWatchControl('i:o')).toBeUndefined()
    expect(parseTelegramWatchControl('wb:zzz')).toBeUndefined()
  })

  it('keeps payloads well inside the callback data cap', () => {
    for (const data of ['wb:n', 'wb:p', 'wb:t', 'wb:d', 'wb:x']) {
      expect(data.length).toBeLessThanOrEqual(64)
    }
  })
})

describe('telegram html conversion', () => {
  it('escapes html before converting markdown', () => {
    expect(escapeTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('converts the renderer markdown subset', () => {
    expect(toTelegramBoardHtml('**bold** and `code`')).toBe('<b>bold</b> and <code>code</code>')
  })

  it('cannot be tricked into injecting a tag through content', () => {
    expect(toTelegramBoardHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('leaves prices and ranges untouched', () => {
    expect(toTelegramBoardHtml('Zone `62,900-63,250` at 1.14718')).toBe('Zone <code>62,900-63,250</code> at 1.14718')
  })
})

describe('clampBoardIndex', () => {
  it('clamps into range', () => {
    expect(clampBoardIndex(-4, 3)).toBe(0)
    expect(clampBoardIndex(9, 3)).toBe(2)
    expect(clampBoardIndex(1, 3)).toBe(1)
  })

  it('reports 0 for an empty board', () => {
    expect(clampBoardIndex(5, 0)).toBe(0)
  })

  it('survives a non-finite index', () => {
    expect(clampBoardIndex(Number.NaN, 3)).toBe(0)
  })
})

describe('toggleExpanded', () => {
  it('adds and removes without mutating the input', () => {
    const before = new Set(['a'])
    const added = toggleExpanded(before, 'b')
    expect([...added].sort()).toEqual(['a', 'b'])
    expect([...before]).toEqual(['a'])
    expect([...toggleExpanded(added, 'a')]).toEqual(['b'])
  })
})

describe('formatTelegramWatcherBoard', () => {
  it('renders an explicit empty state with only a close button', () => {
    const form = board({ items: [] })
    expect(form.html).toContain('no watchers armed')
    expect(form.actions).toEqual([[{ text: '\u2716 Close', data: 'wb:x' }]])
    expect(form.index).toBe(0)
  })

  it('shows the pager position and hides Previous on the first watcher', () => {
    const form = board({ index: 0 })
    expect(form.html).toContain('1 of 3')
    expect(form.actions[1]).toEqual([{ text: 'Next \u25B6', data: 'wb:n' }])
  })

  it('shows both arrows in the middle', () => {
    const form = board({ index: 1 })
    expect(form.html).toContain('2 of 3')
    expect(form.actions[1]).toEqual([
      { text: '\u25C0 Previous', data: 'wb:p' },
      { text: 'Next \u25B6', data: 'wb:n' },
    ])
  })

  it('hides Next on the last watcher', () => {
    const form = board({ index: 2 })
    expect(form.html).toContain('3 of 3')
    expect(form.actions[1]).toEqual([{ text: '\u25C0 Previous', data: 'wb:p' }])
  })

  it('carries the always-present action row', () => {
    const form = board()
    expect(form.actions[0]).toEqual([
      { text: '\uD83D\uDD0E Details', data: 'wb:t' },
      { text: '\uD83D\uDDD1 Delete', data: 'wb:d' },
      { text: '\u2716 Close', data: 'wb:x' },
    ])
  })

  it('collapsed shows only the card, expanded replaces it with the detail panel', () => {
    const collapsed = board({ index: 1 })
    expect(collapsed.html).not.toContain('Trigger progress')
    // Collapsed renders the compact card header for ETHUSDT.
    expect(collapsed.html).toContain('\u003cb\u003eETHUSDT\u003c/b\u003e')
    const expanded = board({ index: 1, expanded: new Set(['w-2']) })
    expect(expanded.html).toContain('Trigger progress')
    // Expanded REPLACES the card. The compact header must not also appear, or
    // the operator sees the whole card stacked above the full detail panel.
    expect(expanded.html).not.toContain('\u003cb\u003eETHUSDT\u003c/b\u003e')
    expect(expanded.html).toContain('\u003cb\u003eETHUSDT Watcher\u003c/b\u003e')
    expect(expanded.actions[0]?.[0]).toEqual({ text: '\uD83D\uDD3C Collapse', data: 'wb:t' })
  })

  it('keeps a foreign watcher expanded state from leaking across the pager', () => {
    // w-1 expanded, but the pager is on w-2: the button must read Details.
    const form = board({ index: 1, expanded: new Set(['w-1']) })
    expect(form.actions[0]?.[0]?.text).toContain('Details')
  })

  it('reports the clamped index so the caller persists the real position', () => {
    const form = board({ index: 99 })
    expect(form.index).toBe(2)
    expect(form.html).toContain('3 of 3')
  })

  it('renders html tags rather than literal asterisks', () => {
    const form = board()
    expect(form.html).toContain('<b>Watcher Board</b>')
    expect(form.html).not.toContain('**')
  })

  it('never exceeds the Telegram text cap', () => {
    const many = Array.from({ length: 60 }, (_, index) => item(`w-${index}`, 'BTCUSDT'))
    const form = board({ items: many, index: 0, expanded: new Set(['w-0']) })
    expect(form.html.length).toBeLessThanOrEqual(4000)
  })
})
