/** Settings → Memory. Owner-facing surface for the agent's durable memory.
 *
 * The agent writes memory through `memory_save` / `memory_forget` after asking
 * in conversation; this page is where the owner reads what accumulated, fixes
 * a badly worded entry, edits the standing operating rules, or deletes
 * something no longer true. There is deliberately no approve/deny queue: the
 * gate is the conversation, not a second inbox to manage.
 */

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'

import { useMemory, type MemoryEntry, type MemoryType } from '../hooks/useMemory'
import { PageHeader } from '../components/PageHeader'
import { SettingsScrollArea } from '../components/form'

const TYPE_LABEL: Record<MemoryType, string> = {
  user: 'User',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
}

const TYPE_HINT: Record<MemoryType, string> = {
  user: 'Who you are and how you want the agent to work.',
  feedback: 'A correction or lesson, with the condition it applies to.',
  project: 'Durable context about ongoing work.',
  reference: 'A pointer to a source or method.',
}

function formatDate(ms: number): string {
  if (!ms) return 'unknown'
  return new Date(ms).toLocaleString()
}

function RulePanel({ rule, onSave }: { rule: string; onSave: (next: string) => Promise<void> }) {
  const [draft, setDraft] = useState(rule)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The rule arrives asynchronously. Seeding `useState(rule)` alone left the
  // editor empty whenever Edit was pressed before (or after) the fetch landed,
  // because the initializer only runs on first mount.
  useEffect(() => {
    if (!editing) setDraft(rule)
  }, [rule, editing])

  const dirty = draft !== rule

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Operating rules</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Injected into every session. Written once on first boot, then owned by you.
          </p>
        </div>
        {editing ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
              onClick={() => { setDraft(rule); setEditing(false); setError(null) }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!dirty || saving}
              className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
              onClick={() => {
                setSaving(true)
                setError(null)
                void onSave(draft)
                  .then(() => setEditing(false))
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setSaving(false))
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </header>
      {error ? <p className="px-4 py-2 text-xs text-destructive">{error}</p> : null}
      <div className="px-4 py-3">
        {editing ? (
          <textarea
            className="min-h-[320px] w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
          />
        ) : (
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
            {rule || 'No rules yet.'}
          </pre>
        )}
      </div>
    </section>
  )
}

function EntryRow({
  entry,
  onSave,
  onDelete,
}: {
  entry: MemoryEntry
  onSave: (patch: { title?: string; description?: string; body?: string }) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(entry.body)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex items-start gap-2 px-4 py-3">
        <button
          type="button"
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="truncate text-left text-sm font-medium hover:underline"
              onClick={() => setOpen((value) => !value)}
            >
              {entry.title}
            </button>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {TYPE_LABEL[entry.type]}
            </span>
          </div>
          {entry.description && entry.description !== entry.title ? (
            <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
          ) : null}
          <p className="mt-1 text-[11px] text-muted-foreground">Updated {formatDate(entry.updatedAt)}</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
          aria-label={`Delete ${entry.title}`}
          onClick={() => { void onDelete() }}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {open ? (
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
          {editing ? (
            <>
              <textarea
                className="min-h-[160px] w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                spellCheck={false}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  disabled={saving || !body.trim()}
                  className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
                  onClick={() => {
                    setSaving(true)
                    setError(null)
                    void onSave({ body })
                      .then(() => setEditing(false))
                      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                      .finally(() => setSaving(false))
                  }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                  onClick={() => { setBody(entry.body); setEditing(false); setError(null) }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{entry.body}</pre>
              <button
                type="button"
                className="mt-2 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => setEditing(true)}
              >
                Edit text
              </button>
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}

export function MemorySettingsPage() {
  const memory = useMemory()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Memory" />
      <SettingsScrollArea className="px-4 py-5 md:px-8">
        <div className="mx-auto w-full max-w-[1100px] space-y-6">
          <RulePanel rule={memory.rule} onSave={memory.saveRule} />

          <section className="rounded-lg border border-border bg-card">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-medium">Saved memory</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The agent proposes these in conversation and saves them only with your go-ahead.
                  They are injected into every future session.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">{memory.entries.length} entries</span>
            </header>

            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <input
                className="min-w-[200px] flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                placeholder="Search memory…"
                value={memory.query}
                onChange={(event) => memory.setQuery(event.target.value)}
              />
              <select
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={memory.typeFilter}
                onChange={(event) => memory.setTypeFilter(event.target.value as MemoryType | 'all')}
              >
                <option value="all">All types</option>
                {memory.types.map((type) => (
                  <option key={type} value={type}>{TYPE_LABEL[type]}</option>
                ))}
              </select>
            </div>

            {memory.loading ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">Loading memory…</p>
            ) : memory.error ? (
              <p className="px-4 py-6 text-sm text-destructive">{memory.error}</p>
            ) : memory.visible.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {memory.entries.length === 0
                  ? 'No entries yet. When the agent learns something worth keeping, it will ask you before saving it.'
                  : 'No entries match this filter.'}
              </p>
            ) : (
              <ul>
                {memory.visible.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    onSave={(patch) => memory.updateEntry(entry.id, patch)}
                    onDelete={() => memory.deleteEntry(entry.id)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card px-4 py-3">
            <h2 className="text-sm font-medium">How memory is written</h2>
            <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
              {memory.types.map((type) => (
                <li key={type}>
                  <span className="font-medium text-foreground">{TYPE_LABEL[type]}:</span> {TYPE_HINT[type]}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Stored as plain Markdown under <code className="font-mono">~/.openalice/data/memory/</code>.
              Nothing here is model-writable without your explicit approval in conversation, and
              skill edits use the same rule.
            </p>
          </section>
        </div>
      </SettingsScrollArea>
    </div>
  )
}
