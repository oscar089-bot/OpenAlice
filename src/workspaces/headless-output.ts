/** Vendor-neutral structured output for one-shot agent runs. */

export type HeadlessOutputEvent =
  | { readonly type: 'text'; readonly text: string; readonly delta?: boolean }
  | { readonly type: 'tool-start'; readonly id: string; readonly name: string; readonly input?: unknown }
  | {
      readonly type: 'tool-finish'
      readonly id: string
      readonly name?: string
      readonly output?: unknown
      readonly isError?: boolean
    }
  | { readonly type: 'error'; readonly message: string }

export type HeadlessToolStatus = 'running' | 'completed' | 'failed'

export type HeadlessMessageBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool'
      readonly id: string
      readonly name: string
      readonly status: HeadlessToolStatus
      readonly input?: unknown
      readonly output?: unknown
      /** Wall-clock duration in ms, measured from tool-start. Finished tools only. */
      readonly durationMs?: number
      /** One-line failure reason. Set only when `status === 'failed'`. */
      readonly error?: string
    }
  | { readonly type: 'error'; readonly message: string }

export interface HeadlessStructuredOutput {
  readonly schemaVersion: 1
  readonly assistantText: string | null
  readonly blocks: readonly HeadlessMessageBlock[]
  readonly metrics: {
    readonly textBlocks: number
    readonly toolCalls: number
    readonly toolFailures: number
  }
  /** True when the source log or normalized block budget was truncated. */
  readonly truncated: boolean
}

const MAX_BLOCKS = 300
const MAX_TEXT_CHARS = 64 * 1024
const MAX_TOOL_VALUE_CHARS = 8 * 1024
/** One chat line's worth. Long enough for `exit code 1` and a short reason. */
const MAX_TOOL_ERROR_CHARS = 200

function clipText(value: string, max = MAX_TEXT_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… (truncated)`
}

function boundedValue(value: unknown): unknown {
  if (value === undefined) return undefined
  if (typeof value === 'string') return clipText(value, MAX_TOOL_VALUE_CHARS)
  try {
    const json = JSON.stringify(value)
    if (json.length <= MAX_TOOL_VALUE_CHARS) return value
    return `${json.slice(0, MAX_TOOL_VALUE_CHARS)}… (truncated)`
  } catch {
    return clipText(String(value), MAX_TOOL_VALUE_CHARS)
  }
}

/**
 * Reduce a failed tool's output to ONE short line.
 *
 * This is the only tool output that ever reaches a chat surface, and it is
 * deliberately narrow: a failure with no reason is not actionable, but a full
 * stack trace is unreadable in a chat bubble and can leak absolute paths. Take
 * the first non-empty line, strip anything path-shaped, and clip hard.
 */
function summarizeToolError(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  let text: string
  if (typeof output === 'string') text = output
  else if (Array.isArray(output)) {
    // Claude tool_result content is often `[{ type: 'text', text: '...' }]`.
    text = output
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .filter(Boolean)
      .join('\n')
  } else if (typeof output === 'object' && typeof (output as { message?: unknown }).message === 'string') {
    text = (output as { message: string }).message
  } else {
    try { text = JSON.stringify(output) } catch { text = String(output) }
  }
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return undefined
  return line.length <= MAX_TOOL_ERROR_CHARS ? line : `${line.slice(0, MAX_TOOL_ERROR_CHARS - 1)}…`
}

/** Pairs tool start/end events and keeps one final assistant reply projection. */
export class HeadlessOutputAccumulator {
  private readonly blocks: HeadlessMessageBlock[] = []
  private readonly toolIndexes = new Map<string, number>()
  /** Wall-clock ms a tool started, keyed by tool id, for duration reporting. */
  private readonly toolStartedAt = new Map<string, number>()
  private assistantText: string | null = null
  private sourceTruncated = false
  private blockTruncated = false

  /** Injectable so duration reporting is deterministic under test. */
  constructor(private readonly now: () => number = Date.now) {}

  add(events: readonly HeadlessOutputEvent[]): void {
    for (const event of events) {
      if (event.type === 'text') {
        const raw = event.delta ? event.text : event.text.trim()
        const text = clipText(raw)
        if (!text) continue
        if (event.delta) {
          const previous = this.blocks[this.blocks.length - 1]
          if (previous?.type === 'text') {
            this.assistantText = clipText(`${this.assistantText ?? ''}${text}`)
            this.blocks[this.blocks.length - 1] = { type: 'text', text: clipText(`${previous.text}${text}`) }
          } else {
            // A new utterance after a tool/error is the current reply, not a
            // concatenation of every earlier narration token.
            this.assistantText = text
            this.push({ type: 'text', text })
          }
          continue
        }
        this.assistantText = text
        const previous = this.blocks[this.blocks.length - 1]
        if (previous?.type === 'text' && previous.text === text) continue
        this.push({ type: 'text', text })
        continue
      }

      if (event.type === 'error') {
        const message = clipText(event.message.trim(), MAX_TOOL_VALUE_CHARS)
        const previous = this.blocks[this.blocks.length - 1]
        if (message && !(previous?.type === 'error' && previous.message === message)) {
          this.push({ type: 'error', message })
        }
        continue
      }

      if (event.type === 'tool-start') {
        // A blank id cannot pair start/finish and fails the persisted progress
        // contract (`id` must be non-empty), so it is not a usable tool block.
        if (!event.id.trim()) continue
        const index = this.toolIndexes.get(event.id)
        const next: Extract<HeadlessMessageBlock, { type: 'tool' }> = {
          type: 'tool',
          id: event.id,
          name: event.name || 'Tool',
          status: 'running',
          ...(event.input !== undefined ? { input: boundedValue(event.input) } : {}),
        }
        if (index === undefined) {
          if (this.push(next)) {
            this.toolIndexes.set(event.id, this.blocks.length - 1)
            this.toolStartedAt.set(event.id, this.now())
          }
        } else {
          const current = this.blocks[index]
          this.blocks[index] = current?.type === 'tool' ? { ...current, ...next } : next
        }
        continue
      }

      if (!event.id.trim()) continue
      const index = this.toolIndexes.get(event.id)
      const current = index === undefined ? null : this.blocks[index]
      const startedAt = this.toolStartedAt.get(event.id)
      const failed = event.isError === true
      const elapsed = startedAt === undefined ? undefined : Math.max(0, this.now() - startedAt)
      const finished: Extract<HeadlessMessageBlock, { type: 'tool' }> = {
        type: 'tool',
        id: event.id,
        name: event.name || (current?.type === 'tool' ? current.name : 'Tool'),
        status: failed ? 'failed' : 'completed',
        ...(current?.type === 'tool' && current.input !== undefined ? { input: current.input } : {}),
        ...(event.output !== undefined ? { output: boundedValue(event.output) } : {}),
        // Omitted at 0. On a 1ms-resolution clock that means start and finish
        // landed in the same tick, which cannot be told apart from "instant" —
        // reporting `(0s)` would invent precision the measurement does not have.
        ...(elapsed !== undefined && elapsed > 0 ? { durationMs: elapsed } : {}),
        ...(failed ? (() => { const e = summarizeToolError(event.output); return e ? { error: e } : {} })() : {}),
      }
      this.toolStartedAt.delete(event.id)
      if (index === undefined) {
        if (this.push(finished)) this.toolIndexes.set(event.id, this.blocks.length - 1)
      } else {
        this.blocks[index] = finished
      }
    }
  }

  /** Adapter text decoders remain a compatibility/final-result fallback. */
  setAssistantText(text: string): void {
    const normalized = clipText(text.trim())
    if (normalized) this.assistantText = normalized
  }

  markSourceTruncated(): void {
    this.sourceTruncated = true
  }

  snapshot(runStillActive = false): HeadlessStructuredOutput {
    const blocks = this.blocks.map((block) => {
      if (block.type !== 'tool' || block.status !== 'running' || runStillActive) return block
      return { ...block, status: 'failed' as const }
    })
    const tools = blocks.filter(
      (block): block is Extract<HeadlessMessageBlock, { type: 'tool' }> => block.type === 'tool',
    )
    return {
      schemaVersion: 1,
      assistantText: this.assistantText,
      blocks,
      metrics: {
        textBlocks: blocks.reduce((count, block) => count + (block.type === 'text' ? 1 : 0), 0),
        toolCalls: tools.length,
        toolFailures: tools.reduce((count, block) => count + (block.status === 'failed' ? 1 : 0), 0),
      },
      truncated: this.sourceTruncated || this.blockTruncated,
    }
  }

  private push(block: HeadlessMessageBlock): boolean {
    if (this.blocks.length >= MAX_BLOCKS) {
      this.blockTruncated = true
      return false
    }
    this.blocks.push(block)
    return true
  }
}

export function parseHeadlessOutputText(opts: {
  readonly text: string
  readonly extractEvents?: (line: string) => readonly HeadlessOutputEvent[]
  readonly extractAssistantText?: (line: string) => string | null
  readonly sourceTruncated?: boolean
  readonly runStillActive?: boolean
  /** Injectable clock, so measured durations stay deterministic under test. */
  readonly now?: () => number
}): HeadlessStructuredOutput {
  const accumulator = new HeadlessOutputAccumulator(opts.now)
  if (opts.sourceTruncated) accumulator.markSourceTruncated()
  for (const raw of opts.text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    accumulator.add(opts.extractEvents?.(line) ?? [])
    const assistant = opts.extractAssistantText?.(line)?.trim()
    if (assistant) accumulator.setAssistantText(assistant)
  }
  return accumulator.snapshot(opts.runStillActive ?? false)
}
