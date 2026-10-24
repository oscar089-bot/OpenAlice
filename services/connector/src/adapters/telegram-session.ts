import { randomBytes } from 'node:crypto'
import type { Context } from 'grammy'
import type { ConnectorSessionPanel, ConnectorSessionRequest } from '@traderalice/connector-protocol'

type Step =
  | 'root'
  | 'sessions'
  | 'session-actions'
  | 'confirm-delete'
  | 'create-policy'
  | 'create-agent'
  | 'create-credential'
  | 'create-model'
  | 'create-effort'
  | 'created'
type State = {
  panel: ConnectorSessionPanel
  expires: number
  nonce: string
  step: Step
  page: number
  busy: boolean
  selectedResumeId?: string
  draft: NonNullable<ConnectorSessionRequest['draft']>
}
const PAGE_SIZE = 6
const TTL = 10 * 60_000
const nonce = () => randomBytes(6).toString('hex')
const key = (ctx: Context) => `${ctx.chat?.id}:${ctx.callbackQuery?.message?.message_id}`
const label = (value: string) => value.length > 60 ? `${value.slice(0, 57)}…` : value

const policyLabel = (policy: string | null | undefined) =>
  policy === 'new-each-run'
    ? 'a new Session every run'
    : policy === 'new-then-resume'
      ? 'one Session, reused'
      : 'not chosen yet'

const agentLabel = (panel: ConnectorSessionPanel, agent: string | null | undefined) =>
  panel.agents.find((option) => option.id === agent)?.label ?? agent ?? 'runtime default'

const credentialLabel = (panel: ConnectorSessionPanel, credential: string | null | undefined) =>
  panel.credentials.find((option) => option.id === credential)?.label ?? credential ?? 'runtime default'

/**
 * Telegram owns only transient panel state here.
 *
 * Alice remains the sole authority for the roster, the runtime options and the
 * commit: every button either re-reads the panel or posts one explicit action,
 * and a stale `nonce` is rejected rather than guessed at. That keeps a chat
 * button from ever inventing a Session or overwriting a newer owner.
 */
export class TelegramSessionControls {
  private readonly states = new Map<string, State>()
  constructor(private readonly now: () => number = Date.now) {}

  async open(
    ctx: Context,
    call: (request: ConnectorSessionRequest) => Promise<ConnectorSessionPanel>,
  ): Promise<void> {
    for (const [id, state] of this.states) if (state.expires < this.now()) this.states.delete(id)
    if (this.states.size >= 50) this.states.delete(this.states.keys().next().value!)
    try {
      const panel = await call({})
      const state: State = {
        panel, expires: this.now() + TTL, nonce: nonce(), step: 'root', page: 0, busy: false,
        draft: { ...(panel.draft ?? {}) },
      }
      const message = await ctx.reply(this.text(state), { reply_markup: this.keyboard(state) })
      this.states.set(`${ctx.chat?.id}:${message.message_id}`, state)
    } catch (error) {
      await ctx.reply(this.error(error))
    }
  }

  private error(error: unknown): string {
    return `Could not open Session settings: ${error instanceof Error ? error.message : 'Open /session and try again.'}`
  }

  /** Commit the finished draft. This is the only place a create is saved. */
  private async commit(
    state: State,
    call: (request: ConnectorSessionRequest) => Promise<ConnectorSessionPanel>,
  ): Promise<ConnectorSessionPanel> {
    return call({
      view: 'create',
      draft: state.draft,
      revision: state.panel.revision,
      apply: true,
    })
  }

  /** Handle one button press. Alice is re-read after every commit. */
  async handle(
    ctx: Context,
    call: (request: ConnectorSessionRequest) => Promise<ConnectorSessionPanel>,
  ): Promise<void> {
    // `vault:<slug>` carries the callback delimiter inside the value. Taking a
    // fixed 4th segment would truncate it to `vault` and silently select a
    // credential that does not exist, so everything after the action rejoins.
    const parts = (ctx.callbackQuery?.data ?? '').split(':')
    const token = parts[1]
    const action = parts[2]
    const argument = parts.slice(3).join(':')
    const state = this.states.get(key(ctx))
    if (!state || state.expires < this.now() || state.nonce !== token) {
      await ctx.answerCallbackQuery({ text: 'This panel expired. Open /session again.' })
      return
    }
    if (state.busy) {
      await ctx.answerCallbackQuery({ text: 'Working…' })
      return
    }
    state.busy = true
    await ctx.answerCallbackQuery().catch(() => undefined)
    try {
      switch (action) {
        case 'view':
          state.step = argument === 'sessions' ? 'sessions' : 'root'
          state.page = 0
          break
        case 'step':
          state.step = (argument as Step) ?? 'root'
          break
        case 'page':
          state.page = Math.max(0, Number(argument) || 0)
          break
        case 'pick': {
          const row = state.panel.sessions[state.page * PAGE_SIZE + Number(argument)]
          if (!row) throw new Error('That row is no longer available. Reopen /session.')
          state.selectedResumeId = row.resumeId
          state.step = 'session-actions'
          break
        }
        case 'ask-delete':
          state.step = 'confirm-delete'
          break
        case 'switch':
        case 'delete':
          if (!state.selectedResumeId) throw new Error('Pick a Session first.')
          state.panel = await call({
            resumeId: state.selectedResumeId,
            revision: state.panel.revision,
            ...(action === 'delete' ? { delete: true } : {}),
            apply: true,
          })
          state.selectedResumeId = undefined
          state.step = 'sessions'
          break
        case 'start-create':
          // The draft is reset so a previous attempt cannot leak into this one.
          state.draft = { policy: null, agent: null, credential: null, model: null, effort: null }
          state.step = 'create-policy'
          break
        case 'draft-policy':
          state.draft.policy = argument === 'new-each-run' ? 'new-each-run' : 'new-then-resume'
          state.step = 'create-agent'
          break
        case 'agent':
          state.draft.agent = argument
          state.draft.credential = null
          state.draft.model = null
          state.draft.effort = null
          state.panel = await call({ view: 'create', draft: state.draft })
          state.step = 'create-credential'
          break
        case 'credential':
          state.draft.credential = argument === 'none' ? null : argument
          state.draft.model = null
          state.draft.effort = null
          state.panel = await call({ view: 'create', draft: state.draft })
          state.step = 'create-model'
          break
        case 'model':
          state.draft.model = argument === 'none' ? null : argument
          state.draft.effort = null
          state.panel = await call({ view: 'create', draft: state.draft })
          // Effort is the last step only when the runtime publishes a tier
          // menu. Committing immediately otherwise stops the flow from ending
          // on a screen with nothing left to choose.
          if (state.panel.efforts.length > 0) {
            state.step = 'create-effort'
          } else {
            state.panel = await this.commit(state, call)
            state.step = 'created'
          }
          break
        case 'effort':
          state.draft.effort = argument === 'none' ? null : argument
          state.panel = await this.commit(state, call)
          state.step = 'created'
          break
        case 'close':
          await ctx.editMessageText('Session settings closed.', { reply_markup: { inline_keyboard: [] } })
          this.states.delete(key(ctx))
          return
        default:
          throw new Error('Unknown control. Open /session again.')
      }
      state.nonce = nonce()
      await ctx.editMessageText(this.text(state), { reply_markup: this.keyboard(state) })
    } catch (error) {
      await ctx.reply(`Session settings: ${error instanceof Error ? error.message : 'Try again.'}`)
    } finally {
      state.busy = false
    }
  }

  /** Roster + current owner, so the owner always knows who answers next. */
  private text(state: State): string {
    const { panel, step, page } = state
    const current = panel.currentResumeId
      ? panel.sessions.find((row) => row.resumeId === panel.currentResumeId)?.label ?? panel.currentResumeId
      : panel.assignee === '@new-each-run'
        ? 'A fresh Session on every run'
        : 'A fresh Session on the next message'
    const lines = [
      panel.saved ? 'Saved.' : 'Session settings',
      `Current: ${current}`,
    ]
    if (panel.running) lines.push('A reply is running. Switch and delete are unavailable until it finishes.')
    if (step === 'sessions' || step === 'root') {
      const rows = panel.sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      lines.push('', `Sessions · page ${page + 1}/${panel.pageCount}`)
      if (rows.length === 0) lines.push('No Sessions in this desk Workspace yet.')
      for (const row of rows) {
        const flags = [
          row.current ? 'current' : '',
          row.running ? 'running' : '',
          row.presence === 'deleted' ? 'deleted' : '',
        ].filter(Boolean)
        lines.push(`• ${row.label} · ${row.agent}${flags.length ? ` (${flags.join(', ')})` : ''}`)
      }
    }
    if (step === 'create-policy') {
      lines.push('', 'Step 1 of 5 · Assignment policy')
      lines.push('Choose how this desk picks its Session.')
    }
    if (step === 'create-agent') {
      lines.push('', 'Step 2 of 5 · Runtime')
      lines.push(`Policy: ${policyLabel(state.draft.policy)}`)
      lines.push('Choose the agent that will run this Session.')
    }
    if (step === 'create-credential') {
      lines.push('', 'Step 3 of 5 · Credential')
      lines.push(`Runtime: ${agentLabel(panel, state.draft.agent)}`)
      lines.push('Which AI login should it use? `Runtime login` means the CLI’s own account.')
    }
    if (step === 'create-model') {
      lines.push('', 'Step 4 of 5 · Model')
      lines.push(`Runtime: ${agentLabel(panel, state.draft.agent)} · Credential: ${credentialLabel(panel, state.draft.credential)}`)
      lines.push('Choose the model for this Session.')
    }
    if (step === 'create-effort') {
      lines.push('', 'Step 5 of 5 · Reasoning effort')
      lines.push(`Runtime: ${agentLabel(panel, state.draft.agent)} · Model: ${state.draft.model ?? 'runtime default'}`)
      lines.push('How hard should it think before answering?')
    }
    if (step === 'created') {
      lines.push('', 'Session prepared')
      lines.push(`Runtime: ${agentLabel(panel, state.draft.agent)}`)
      lines.push(`Credential: ${credentialLabel(panel, state.draft.credential)}`)
      lines.push(`Model: ${state.draft.model ?? 'runtime default'}`)
      lines.push(`Effort: ${state.draft.effort ?? 'runtime default'}`)
      lines.push(`Policy: ${policyLabel(state.draft.policy)}`)
      lines.push('', 'Your next message starts this Session here.')
    }
    if (step === 'session-actions' || step === 'confirm-delete') {
      const row = panel.sessions.find((candidate) => candidate.resumeId === state.selectedResumeId)
      if (row) {
        lines.push('', `${row.label} · ${row.agent}`)
        if (row.current) lines.push('This is the Session answering now.')
        if (row.running) lines.push('A reply is running for this Session.')
      }
      if (step === 'confirm-delete') lines.push('', 'Delete this Session and its messages permanently?')
    }
    lines.push('', 'Deleting removes that Session and its messages for good.')
    return lines.join('\n').slice(0, 3900)
  }

  private keyboard(state: State) {
    const button = (text: string, action: string) => ({
      text: label(text),
      callback_data: `ses:${state.nonce}:${action}`,
    })
    const rows: Array<Array<{ text: string; callback_data: string }>> = []
    const at = state.page * PAGE_SIZE
    const rowsOnPage = state.panel.sessions.slice(at, at + PAGE_SIZE)

    if (state.step === 'root') {
      rows.push([button('Sessions', 'view:sessions'), button('New Session', 'start-create')])
      rows.push([button('Close', 'close')])
    } else if (state.step === 'sessions') {
      for (const [index, row] of rowsOnPage.entries()) {
        const mark = row.current ? '✓ ' : ''
        rows.push([button(`${mark}${row.label}`, `pick:${at + index}`)])
      }
      const nav = []
      if (state.page > 0) nav.push(button('‹ Previous', `page:${state.page - 1}`))
      if ((state.page + 1) * PAGE_SIZE < state.panel.sessions.length) nav.push(button('Next ›', `page:${state.page + 1}`))
      if (nav.length) rows.push(nav)
      // Delete is offered only for a row the owner just selected, never as a
      // one-tap action on a list they are merely browsing.
      rows.push([button('Back', 'step:root')])
    } else if (state.step === 'session-actions') {
      const row = state.panel.sessions.find((candidate) => candidate.resumeId === state.selectedResumeId)
      if (row && !row.current && row.presence !== 'deleted') rows.push([button('Switch to this Session', 'switch')])
      if (row && row.presence !== 'deleted') rows.push([button('Delete Session', 'ask-delete')])
      rows.push([button('Back', 'view:sessions')])
    } else if (state.step === 'confirm-delete') {
      rows.push([button('Delete permanently', 'delete')])
      rows.push([button('Cancel', 'view:sessions')])
    } else if (state.step === 'create-policy') {
      rows.push([button('One Session, reused', 'draft-policy:new-then-resume')])
      rows.push([button('A new Session every run', 'draft-policy:new-each-run')])
      rows.push([button('Back', 'step:root')])
    } else if (state.step === 'create-agent') {
      for (const agent of state.panel.agents) rows.push([button(agent.label, `agent:${agent.id}`)])
      rows.push([button('Back', 'start-create')])
    } else if (state.step === 'create-credential') {
      for (const credential of state.panel.credentials) rows.push([button(credential.label, `credential:${credential.id}`)])
      rows.push([button('Skip', 'credential:none')])
      rows.push([button('Back', 'step:create-agent')])
    } else if (state.step === 'create-model') {
      for (const model of state.panel.models.slice(0, 20)) rows.push([button(model.label, `model:${model.id}`)])
      rows.push([button('Skip', 'model:none')])
      rows.push([button('Back', 'step:create-credential')])
    } else if (state.step === 'create-effort') {
      for (const effort of state.panel.efforts) rows.push([button(effort, `effort:${effort}`)])
      rows.push([button('Skip', 'effort:none')])
      rows.push([button('Back', 'step:create-model')])
    } else if (state.step === 'created') {
      rows.push([button('Done', 'close')])
    }
    return { inline_keyboard: rows }
  }
}
