import { describe, expect, it, vi } from 'vitest'
import type { ConnectorSessionPanel, ConnectorSessionRequest } from '@traderalice/connector-protocol'

import { TelegramSessionControls } from './telegram-session.js'

function panel(overrides: Partial<ConnectorSessionPanel> = {}): ConnectorSessionPanel {
  return {
    issueId: 'desk',
    currentResumeId: 'resume-current',
    assignee: '@resume-current',
    revision: 'rev-1',
    running: false,
    view: 'sessions',
    page: 0,
    pageCount: 1,
    sessions: [
      { resumeId: 'resume-current', label: 'Desk now', agent: 'claude', current: true, running: false, presence: 'active', updatedAt: 2 },
      { resumeId: 'resume-old', label: 'Desk old', agent: 'claude', current: false, running: false, presence: 'active', updatedAt: 1 },
    ],
    agents: [{ id: 'claude', label: 'Claude', installed: true }],
    credentials: [
      { id: 'native', label: 'Runtime login' },
      { id: 'vault:work-key', label: 'Work key' },
    ],
    models: [{ id: 'sonnet-5', label: 'Sonnet 5' }],
    efforts: ['high'],
    draft: { policy: null, agent: 'claude', credential: 'native', model: null, effort: null },
    ...overrides,
  }
}

function ctxFor(messageId = 1) {
  return {
    chat: { id: 42, type: 'private' },
    from: { id: 42 },
    reply: vi.fn(async () => ({ message_id: messageId })),
    editMessageText: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
  } as any
}

/** Open a panel and expose the nonce it minted. */
async function opened(result: ConnectorSessionPanel, now?: () => number) {
  const controls = new TelegramSessionControls(now)
  const ctx = ctxFor()
  await controls.open(ctx, async () => result)
  const markup = ctx.reply.mock.calls[0]![1].reply_markup
  const nonce = markup.inline_keyboard[0][0].callback_data.split(':')[1]
  return { controls, ctx, nonce }
}

function press(ctx: any, nonce: string, action: string) {
  return { ...ctx, callbackQuery: { data: `ses:${nonce}:${action}`, message: { message_id: 1 } } }
}

/** Every successful press re-mints the nonce and re-renders, so read it back. */
function lastNonce(ctx: any): string {
  const calls = ctx.editMessageText.mock.calls
  const markup = calls[calls.length - 1]![1].reply_markup
  return markup.inline_keyboard[0][0].callback_data.split(':')[1]
}

function lastKeyboard(ctx: any): Array<Array<{ text: string; callback_data: string }>> {
  const calls = ctx.editMessageText.mock.calls
  return calls[calls.length - 1]![1].reply_markup.inline_keyboard
}

function labels(ctx: any): string[] {
  return lastKeyboard(ctx).flat().map((button) => button.text)
}

describe('TelegramSessionControls', () => {
  it('opens on the root view and names the current owner', async () => {
    const { ctx, nonce } = await opened(panel())
    const [text] = ctx.reply.mock.calls[0]!
    expect(text).toContain('Current: Desk now')
    const buttons = ctx.reply.mock.calls[0]![1].reply_markup.inline_keyboard.flat().map((b: any) => b.text)
    expect(buttons).toEqual(['Sessions', 'New Session', 'Close'])
    expect(nonce).toMatch(/^[0-9a-f]{12}$/)
  })

  it('rejects a stale nonce instead of acting on it', async () => {
    const { controls, ctx } = await opened(panel())
    const call = vi.fn()
    await controls.handle(press(ctx, 'deadbeefdead', 'switch'), call)
    expect(call).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'This panel expired. Open /session again.',
    })
  })

  it('rejects a panel past its TTL', async () => {
    let now = 1_000
    const { controls, ctx, nonce } = await opened(panel(), () => now)
    now += 11 * 60_000
    const call = vi.fn()
    await controls.handle(press(ctx, nonce, 'view:sessions'), call)
    expect(call).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'This panel expired. Open /session again.',
    })
  })

  it('reports an open failure instead of throwing', async () => {
    const controls = new TelegramSessionControls()
    const ctx = ctxFor()
    await controls.open(ctx, async () => { throw new Error('Alice is not ready') })
    expect(ctx.reply).toHaveBeenCalledWith('Could not open Session settings: Alice is not ready')
  })

  it('marks the current row and offers no switch for it', async () => {
    const { controls, ctx, nonce } = await opened(panel())
    await controls.handle(press(ctx, nonce, 'view:sessions'), vi.fn())
    expect(labels(ctx)).toContain('✓ Desk now')
    expect(labels(ctx)).toContain('Desk old')

    // Row 0 is the current Session: no self-switch, delete still offered.
    await controls.handle(press(ctx, lastNonce(ctx), 'pick:0'), vi.fn())
    expect(labels(ctx)).not.toContain('Switch to this Session')
    expect(labels(ctx)).toContain('Delete Session')
  })

  it('switches to a selected row with the panel revision', async () => {
    const { controls, ctx, nonce } = await opened(panel())
    const call = vi.fn(async () => panel({ currentResumeId: 'resume-old' }))
    await controls.handle(press(ctx, nonce, 'view:sessions'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'pick:1'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'switch'), call)
    expect(call).toHaveBeenLastCalledWith({
      resumeId: 'resume-old',
      revision: 'rev-1',
      apply: true,
    })
  })

  it('never deletes without the confirmation step', async () => {
    const { controls, ctx, nonce } = await opened(panel())
    const call = vi.fn(async () => panel())
    await controls.handle(press(ctx, nonce, 'view:sessions'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'pick:1'), call)
    expect(call).not.toHaveBeenCalled()

    await controls.handle(press(ctx, lastNonce(ctx), 'ask-delete'), call)
    expect(call).not.toHaveBeenCalled()
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Delete this Session and its messages permanently?')

    await controls.handle(press(ctx, lastNonce(ctx), 'delete'), call)
    expect(call).toHaveBeenLastCalledWith({
      resumeId: 'resume-old',
      revision: 'rev-1',
      delete: true,
      apply: true,
    })
  })

  it('surfaces a server refusal when a reply is running', async () => {
    const { controls, ctx, nonce } = await opened(panel({ running: true }))
    const call = vi.fn(async () => {
      throw new Error('A reply is running. Use /stop first.')
    })
    await controls.handle(press(ctx, nonce, 'view:sessions'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'pick:1'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'switch'), call)
    expect(ctx.reply).toHaveBeenCalledWith('Session settings: A reply is running. Use /stop first.')
  })

  it('walks the create flow and commits automatically after the last step', async () => {
    const { controls, ctx, nonce } = await opened(panel())
    const call = vi.fn(async (request: ConnectorSessionRequest) => panel({
      efforts: ['low', 'high'],
      draft: {
        policy: request.draft?.policy ?? null,
        agent: request.draft?.agent ?? null,
        credential: request.draft?.credential ?? null,
        model: request.draft?.model ?? null,
        effort: request.draft?.effort ?? null,
      },
    }))

    // Policy is the first step, not a root button.
    await controls.handle(press(ctx, nonce, 'start-create'), call)
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Step 1 of 5 · Assignment policy')

    await controls.handle(press(ctx, lastNonce(ctx), 'draft-policy:new-then-resume'), call)
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Step 2 of 5 · Runtime')
    expect(labels(ctx)).toContain('Claude')

    await controls.handle(press(ctx, lastNonce(ctx), 'agent:claude'), call)
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Step 3 of 5 · Credential')
    expect(labels(ctx)).toContain('Work key')

    await controls.handle(press(ctx, lastNonce(ctx), 'credential:native'), call)
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Step 4 of 5 · Model')

    await controls.handle(press(ctx, lastNonce(ctx), 'model:sonnet-5'), call)
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Step 5 of 5 · Reasoning effort')

    // Selecting effort commits immediately: no Create button exists.
    expect(labels(ctx)).not.toContain('Create')
    await controls.handle(press(ctx, lastNonce(ctx), 'effort:high'), call)
    expect(call).toHaveBeenLastCalledWith({
      view: 'create',
      draft: { policy: 'new-then-resume', agent: 'claude', credential: 'native', model: 'sonnet-5', effort: 'high' },
      revision: 'rev-1',
      apply: true,
    })
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Session prepared')
  })

  it('skips the effort step when the runtime publishes no tiers', async () => {
    const { controls, ctx, nonce } = await opened(panel())
    const call = vi.fn(async (request: ConnectorSessionRequest) => panel({
      // Cursor-style runtime: effort is encoded in the model id, so the step
      // must not exist at all rather than render an empty screen.
      efforts: [],
      draft: {
        policy: request.draft?.policy ?? null,
        agent: request.draft?.agent ?? null,
        credential: request.draft?.credential ?? null,
        model: request.draft?.model ?? null,
        effort: request.draft?.effort ?? null,
      },
    }))
    await controls.handle(press(ctx, nonce, 'start-create'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'draft-policy:new-then-resume'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'agent:claude'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'credential:native'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'model:sonnet-5'), call)

    // Model was the last step; the create already committed.
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ apply: true }))
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).toContain('Session prepared')
    expect(ctx.editMessageText.mock.calls.at(-1)![0]).not.toContain('Reasoning effort')
  })

  it('keeps a vault credential id intact through callback parsing', async () => {
    const { controls, ctx, nonce } = await opened(panel())
    const call = vi.fn(async () => panel())
    await controls.handle(press(ctx, nonce, 'start-create'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'draft-policy:new-then-resume'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'agent:claude'), call)
    await controls.handle(press(ctx, lastNonce(ctx), 'credential:vault:work-key'), call)
    // `vault:<slug>` contains the callback delimiter; truncating it to `vault`
    // would silently select a credential that does not exist.
    expect(call).toHaveBeenLastCalledWith({
      view: 'create',
      draft: { policy: 'new-then-resume', agent: 'claude', credential: 'vault:work-key', model: null, effort: null },
    })
  })

  it('closes and forgets the panel', async () => {
    const { controls, ctx, nonce } = await opened(panel())
    await controls.handle(press(ctx, nonce, 'close'), vi.fn())
    expect(ctx.editMessageText).toHaveBeenLastCalledWith('Session settings closed.', {
      reply_markup: { inline_keyboard: [] },
    })
    await controls.handle(press(ctx, nonce, 'close'), vi.fn())
    expect(ctx.answerCallbackQuery).toHaveBeenLastCalledWith({
      text: 'This panel expired. Open /session again.',
    })
  })
})
