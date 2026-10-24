/**
 * MemoryStore — durable, user-global agent memory.
 *
 * Sibling of {@link EntityStore} and {@link InboxStore}: file-backed, no
 * database. One markdown file per entry under `data/memory/`, plus a
 * `MEMORY.md` index and a pinned `RULE.md`.
 *
 * Two deliberate differences from those stores:
 *
 *   1. **Writes are proposals, not commits.** A memory tool call lands in
 *      `pending/` and surfaces to the owner for approval. Only an approved
 *      proposal mutates `data/memory/`. Stricter on purpose: an entity is a
 *      watchlist row; memory is standing instruction that changes future
 *      behaviour.
 *   2. **Cross-workspace scope.** Memory is not workspace-scoped, so it lives
 *      in `OPENALICE_HOME/data` rather than under a workspace directory.
 *
 * The index is a *snapshot*: read at session start, injected into the system
 * prompt, then frozen for the life of that session. Preserving the prompt
 * cache is worth more than live reads.
 */

import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { dataPath } from '@/core/paths.js'

/** Mirrors Vibe-Trading's taxonomy so the concepts transfer cleanly. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

export interface MemoryEntry {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly type: MemoryType
  readonly body: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Absolute path of the backing markdown file. */
  readonly file: string
}

export interface MemoryStoreOptions {
  /** Override the root (tests). Defaults to `data/memory`. */
  root?: string
}

/** One direct write. The caller has already obtained the owner's approval in
 *  conversation; the store itself applies no second gate. */
export interface MemoryWrite {
  readonly title: string
  readonly content: string
  readonly type?: MemoryType
  /** Optional one-line disambiguation. Defaults to the title. */
  readonly description?: string
}

export interface IMemoryStore {
  /** Absolute memory directory (RULE.md, MEMORY.md, entries). */
  readonly root: string
  rule(): Promise<string>
  /** Replace RULE.md. Human-only surface; no agent tool calls this. */
  writeRule(text: string): Promise<void>
  snapshot(): Promise<string>
  list(): Promise<MemoryEntry[]>
  search(query: string): Promise<MemoryEntry[]>
  get(id: string): Promise<MemoryEntry | null>
  /** Create or overwrite an entry by title+type. Idempotent on the same slug. */
  save(input: MemoryWrite): Promise<MemoryEntry>
  remove(id: string): Promise<boolean>
  removeByTitle(title: string, type?: MemoryType): Promise<boolean>
  update(id: string, patch: { title?: string; description?: string; body?: string }): Promise<MemoryEntry | null>
  onChanged(listener: () => void): () => void
}

const MAX_INDEX_LINES = 200
const MAX_ENTRY_CHARS = 8000
const DEDUP_WINDOW_MS = 30_000

const SLUG_RE = /[^a-z0-9_-]+/g

function slugify(title: string): string {
  // A memory title is a filename, not a sentence. Real models ignore "short"
  // in a description and pass the whole lesson as the title, producing things
  // like `user_always_emit_real_tool_calls_never_just_describe_them.md`. Keep
  // the first few words so the file stays readable and linkable.
  const words = title.toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  const slug = words
    .replace(SLUG_RE, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return slug || createHash('sha256').update(title).digest('hex').slice(0, 8)
}

function entryId(type: string, slug: string): string {
  return createHash('sha256').update(`${type}:${slug}`).digest('hex').slice(0, 12)
}

/** Strip control bytes but keep newlines and tabs. */
function sanitize(content: string): string {
  return content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function truncate(content: string, limit = MAX_ENTRY_CHARS): string {
  if (content.length <= limit) return content
  return `${content.slice(0, limit)}\n\n[truncated at ${limit} chars]\n`
}

/** Frontmatter and index lines are single-line by construction. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

interface Frontmatter {
  meta: Record<string, string>
  body: string
}

/** Minimal YAML reader for the flat `key: value` shape this store writes. */
export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---\n')) return { meta: {}, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end === -1) return { meta: {}, body: text }
  const head = text.slice(4, end)
  const body = text.slice(end + 5)
  const meta: Record<string, string> = {}
  for (const line of head.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) meta[key] = value
  }
  return { meta, body }
}

function renderEntry(entry: Omit<MemoryEntry, 'file'>): string {
  return [
    '---',
    `id: ${entry.id}`,
    `title: ${oneLine(entry.title)}`,
    `description: ${oneLine(entry.description)}`,
    `type: ${entry.type}`,
    `created_at: ${entry.createdAt}`,
    `updated_at: ${entry.updatedAt}`,
    '---',
    '',
    entry.body,
    '',
  ].join('\n')
}

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value)
}

function parseEntry(text: string, file: string): MemoryEntry | null {
  const { meta, body } = parseFrontmatter(text)
  const type = meta['type'] ?? ''
  if (!isMemoryType(type)) return null
  return {
    id: meta['id'] || entryId(type, basename(file, '.md')),
    title: meta['title'] || basename(file, '.md'),
    description: meta['description'] ?? '',
    type,
    body,
    createdAt: Number(meta['created_at'] ?? 0) || 0,
    updatedAt: Number(meta['updated_at'] ?? 0) || 0,
    file,
  }
}

/** Written once on first boot, then owned by the user. Never overwritten. */
export const DEFAULT_RULE = `# Operating Rules

Standing instruction. These override conversational momentum.

## Certainty

You are a professional. State conclusions plainly and own them.

When you are sure - because you checked, and you can point at the tool result
or artifact that supports you - say so, and hold that position. If the user
pushes back without new evidence, do not fold. Restate the finding, cite the
specific evidence, and name what would change your mind. Agreement without
evidence is not helpfulness; it is a defect, and it costs the user money.

If new evidence appears, weigh it on its merits and say plainly whether it
changes the conclusion. Changing your mind for a reason is strength. Changing
it because someone was annoyed is not.

## Learning from correction

A correction is a fact about a situation, not a standing order.

When corrected, record the lesson with its CONDITION, not just its action.
"Don't do X" is useless. "X was right in situation A and wrong in situation B;
before doing X, check whether you are in A or B" is a lesson you can apply.
Name the trigger you should have checked, and what the evidence looked like on
each side.

Never generalise a correction past the condition it was given for. Never
suppress a correct action because a similar-looking action was once corrected.
Before applying a stored lesson, check whether its condition holds NOW. If it
does not, do the opposite - and say why.

A correction is not a scar. It is a sharper instrument.

## Discipline

Discipline is not negotiable. No amount of pressure makes an unsafe entry safe.

A trade is entered when the evidence meets the rule - not when the user is
impatient, not when the setup is close enough, not when a refusal would be
awkward. Verdicts are the same: a weak setup is a weak setup no matter who asks.

If pushed toward a premature action, refuse once, briefly, naming the specific
missing condition. Do not re-litigate. Do not soften the verdict to end the
conversation. You are the last line of defence, not a mirror.

## Replies

Be brief. Lead with the answer, then only the evidence that changes the decision.

No recap of the conversation. No restating the question. No headers for a
three-sentence answer. Expand when asked, or when the analysis genuinely needs
it - and then be dense, not long. Short and complete, not short and vague.

## Memory and skills

You have durable memory across sessions. Read it freely and often - before an
analysis, before applying a past correction, and when the owner references
something you agreed on before. It costs nothing and prevents you from
repeating a mistake you already paid for.

How you reach it depends on your runtime. If a memory tool is available, use it.
Otherwise the same operations are on the injected alice CLI: alice memory recall,
alice memory save, alice memory forget, alice skill list, alice skill patch. Run
alice memory --help for the exact flags.

You may NOT write without approval. Saving or forgetting memory, and patching a
skill, change how you behave in every future session. Every one of them needs
the owner's explicit go-ahead in the current conversation. Ask first: say what
you want to record or change, and why. Wait for a clear yes. A correction is not
approval to write memory - it is the raw material for a lesson you may then
propose.

When you do record a lesson, record the CONDITION with it. A lesson without its
condition cannot be applied correctly later, and will be misapplied.

Never claim a memory or skill change succeeded until the command returned
success. If the owner declines, drop it and carry on; do not ask twice for the
same thing in one conversation.
`

export function createMemoryStore(opts: MemoryStoreOptions = {}): IMemoryStore {
  const root = opts.root ?? dataPath('memory')
  const rulePath = join(root, 'RULE.md')
  const indexPath = join(root, 'MEMORY.md')

  const emitter = new EventEmitter()
  emitter.setMaxListeners(50)

  // Agents issue tool calls in parallel, so two saves can race on the shared
  // tmp file and corrupt it. Serialize every mutation for this instance.
  let tail: Promise<unknown> = Promise.resolve()
  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = tail.then(op, op)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // Sliding-window dedup: a retry loop must not write the same entry twice.
  const recent = new Map<string, number>()
  function hashOf(input: { title: string; content: string; type?: string }): string {
    return createHash('sha256')
      .update(`${input.title.trim().toLowerCase()}|${input.type ?? ''}|${input.content.trim().toLowerCase()}`)
      .digest('hex')
  }
  function isDuplicate(hash: string): boolean {
    const now = Date.now()
    for (const [key, at] of recent) {
      if (now - at > DEDUP_WINDOW_MS) recent.delete(key)
    }
    if (recent.has(hash)) return true
    recent.set(hash, now)
    return false
  }

  async function ensureDirs(): Promise<void> {
    await mkdir(root, { recursive: true })
  }

  async function readIfExists(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf-8')
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async function atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.tmp`
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, file)
  }

  /** Create RULE.md on first boot only. Once it exists the user owns it; a
   *  shipped-default change must never silently rewrite their edits. */
  async function ensureRule(): Promise<string> {
    await ensureDirs()
    const existing = await readIfExists(rulePath)
    if (existing !== null) return existing
    await atomicWrite(rulePath, DEFAULT_RULE)
    return DEFAULT_RULE
  }

  async function readEntries(): Promise<MemoryEntry[]> {
    await ensureDirs()
    let files: string[]
    try {
      files = await readdir(root)
    } catch {
      return []
    }
    const entries: MemoryEntry[] = []
    for (const name of files) {
      if (!name.endsWith('.md')) continue
      if (name === 'MEMORY.md' || name === 'RULE.md') continue
      const file = join(root, name)
      const text = await readIfExists(file)
      if (text === null) continue
      const entry = parseEntry(text, file)
      if (entry) entries.push(entry)
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async function rebuildIndex(): Promise<void> {
    const entries = await readEntries()
    const lines = entries.map(
      (entry) => `- [${entry.title}](${basename(entry.file)}) - ${oneLine(entry.description) || entry.title}`,
    )
    await atomicWrite(indexPath, `${lines.slice(0, MAX_INDEX_LINES).join('\n')}\n`)
  }

  function emit(): void {
    emitter.emit('changed')
  }

  /** Delete the entry that owns `file`. Shared by id and title lookups so no
   *  method depends on `this`, which breaks when the store is destructured. */
  function deleteEntry(file: string): Promise<boolean> {
    return serialize(async () => {
      try {
        await unlink(file)
      } catch {
        return false
      }
      await rebuildIndex()
      emit()
      return true
    })
  }

  return {
    root,

    async rule() {
      return ensureRule()
    },

    async writeRule(text) {
      return serialize(async () => {
        await ensureDirs()
        await atomicWrite(rulePath, text.endsWith('\n') ? text : `${text}\n`)
        emit()
      })
    },

    async snapshot() {
      await ensureRule()
      const index = await readIfExists(indexPath)
      if (index === null) {
        // Materialize an empty index so a runtime pointed at this file
        // (opencode `instructions`) never sees a dangling path on first boot.
        await atomicWrite(indexPath, '')
        return ''
      }
      return index.split('\n').slice(0, MAX_INDEX_LINES).join('\n').trim()
    },

    async list() {
      return readEntries()
    },

    async search(query) {
      const q = query.trim().toLowerCase()
      const entries = await readEntries()
      if (!q) return entries
      const tokens = q.split(/\s+/).filter(Boolean)
      return entries.filter((entry) => {
        const haystack = `${entry.title} ${entry.description} ${entry.body}`.toLowerCase()
        return tokens.every((token) => haystack.includes(token))
      })
    },

    async get(id) {
      const entries = await readEntries()
      return entries.find((entry) => entry.id === id) ?? null
    },

    async save(input) {
      const type = input.type ?? 'project'
      if (!isMemoryType(type)) {
        throw new Error(`memory.save: type must be one of ${MEMORY_TYPES.join(', ')}`)
      }
      // A title is a label, not a paragraph. Models routinely ignore "short"
      // and pass the entire lesson, so collapse newlines and clip the stored
      // title to a readable length. `content` keeps the full lesson.
      const rawTitle = input.title.replace(/\s+/g, ' ').trim()
      if (!rawTitle) throw new Error('memory.save: title is required')
      const title = rawTitle.length > 80 ? `${rawTitle.slice(0, 77).trimEnd()}...` : rawTitle
      if (!input.content.trim()) throw new Error('memory.save: content is required')

      const hash = hashOf({ title, content: input.content, type })
      if (isDuplicate(hash)) {
        throw new Error('Duplicate write blocked: the same entry was saved moments ago.')
      }

      await ensureDirs()
      const slug = slugify(title)
      const id = entryId(type, slug)
      const file = join(root, `${type}_${slug}.md`)
      const now = Date.now()

      // Preserve createdAt when overwriting the same slug so the index does
      // not silently reorder on an update-in-place.
      let createdAt = now
      const existing = parseEntry((await readIfExists(file)) ?? '', file)
      if (existing) createdAt = existing.createdAt || now

      const entry: MemoryEntry = {
        id,
        title,
        description: oneLine(input.description ?? title),
        type,
        body: truncate(sanitize(input.content)),
        createdAt,
        updatedAt: now,
        file,
      }

      return serialize(async () => {
        await atomicWrite(file, renderEntry(entry))
        await rebuildIndex()
        emit()
        return entry
      })
    },

    async removeByTitle(title, type) {
      const target = title.trim().toLowerCase()
      const entries = await readEntries()
      const entry = entries.find(
        (candidate) =>
          candidate.title.trim().toLowerCase() === target && (type === undefined || candidate.type === type),
      )
      if (!entry) return false
      return deleteEntry(entry.file)
    },

    async remove(id) {
      const entries = await readEntries()
      const entry = entries.find((candidate) => candidate.id === id)
      if (!entry) return false
      return deleteEntry(entry.file)
    },

    async update(id, patch) {
      const entries = await readEntries()
      const entry = entries.find((candidate) => candidate.id === id)
      if (!entry) return null
      const next: MemoryEntry = {
        ...entry,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.body !== undefined ? { body: sanitize(patch.body) } : {}),
        updatedAt: Date.now(),
      }
      return serialize(async () => {
        await atomicWrite(entry.file, renderEntry(next))
        await rebuildIndex()
        emit()
        return next
      })
    },

    onChanged(listener) {
      emitter.on('changed', listener)
      return () => emitter.off('changed', listener)
    },
  }
}


