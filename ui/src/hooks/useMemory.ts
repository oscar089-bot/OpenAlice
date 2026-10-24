/** Domain hook for the durable agent memory surface.
 *
 * Presentation components stay prop-driven; this hook owns fetching, the
 * selected entry, and the mutation semantics. Reads and owner edits only — the
 * agent writes through MCP tools, so there is no approval queue here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchJson } from '../api/client'

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryEntry {
  id: string
  title: string
  description: string
  type: MemoryType
  body: string
  createdAt: number
  updatedAt: number
}

interface MemoryPayload {
  rule: string
  entries: MemoryEntry[]
}

const TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

export function useMemory() {
  const [rule, setRule] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<MemoryType | 'all'>('all')
  const [revision, setRevision] = useState(0)

  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void fetchJson<MemoryPayload>('/api/memory', { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return
        setRule(payload.rule)
        setEntries(payload.entries)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [revision])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (typeFilter !== 'all' && entry.type !== typeFilter) return false
      if (!needle) return true
      const haystack = `${entry.title} ${entry.description} ${entry.body}`.toLowerCase()
      return needle.split(/\s+/).every((token) => haystack.includes(token))
    })
  }, [entries, query, typeFilter])

  const saveRule = useCallback(async (next: string) => {
    await fetchJson('/api/memory/rule', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: next }),
    })
    setRule(next)
  }, [])

  const updateEntry = useCallback(async (
    id: string,
    patch: { title?: string; description?: string; body?: string },
  ) => {
    await fetchJson(`/api/memory/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    refresh()
  }, [refresh])

  const deleteEntry = useCallback(async (id: string) => {
    await fetchJson(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
    refresh()
  }, [refresh])

  return {
    rule,
    entries,
    visible,
    loading,
    error,
    query,
    setQuery,
    typeFilter,
    setTypeFilter,
    types: TYPES,
    refresh,
    saveRule,
    updateEntry,
    deleteEntry,
  }
}
