import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore, type IMemoryStore } from '../core/memory-store.js'
import { memoryRecallFactory, memorySaveFactory, memoryForgetFactory, skillPatchFactory, skillListFactory } from './memory.js'
import type { WorkspaceToolContext } from '../core/workspace-tool-center.js'

/** Minimal context: the factories only read memoryStore + resolveWorkspace. */
function ctxFor(memoryStore: IMemoryStore, dir: string): WorkspaceToolContext {
  return {
    workspaceId: 'ws-test',
    workspaceLabel: 'test',
    inboxStore: {} as never,
    entityStore: {} as never,
    memoryStore,
    resolveWorkspace: () => ({ id: 'ws-test', dir, tag: 'test' }),
  }
}

async function run(tool: unknown, input: Record<string, unknown>): Promise<unknown> {
  const execute = (tool as { execute?: (input: unknown) => Promise<unknown> }).execute
  if (!execute) throw new Error('tool has no execute')
  return execute(input)
}

describe('memory tools', () => {
  let root: string
  let workspace: string
  let store: IMemoryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-memtools-'))
    workspace = await mkdtemp(join(tmpdir(), 'openalice-ws-'))
    store = createMemoryStore({ root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  it('memory_save writes an entry the recall tool can find', async () => {
    const ctx = ctxFor(store, workspace)
    const saved = await run(memorySaveFactory.build(ctx), {
      title: 'Session open confirmation',
      content: 'Wait for confirmation only when the setup is unconfirmed.',
      type: 'feedback',
    }) as { ok: boolean }
    expect(saved.ok).toBe(true)

    const recalled = await run(memoryRecallFactory.build(ctx), { query: 'confirmation' }) as {
      ok: boolean
      count: number
      memories: { title: string }[]
    }
    expect(recalled.count).toBe(1)
    expect(recalled.memories[0]?.title).toBe('Session open confirmation')
  })

  it('memory_recall with an empty query returns everything', async () => {
    const ctx = ctxFor(store, workspace)
    await run(memorySaveFactory.build(ctx), { title: 'A', content: 'one' })
    await run(memorySaveFactory.build(ctx), { title: 'B', content: 'two' })
    const recalled = await run(memoryRecallFactory.build(ctx), { query: '' }) as { count: number }
    expect(recalled.count).toBe(2)
  })

  it('memory_forget removes by id and reports a miss honestly', async () => {
    const ctx = ctxFor(store, workspace)
    const saved = await run(memorySaveFactory.build(ctx), { title: 'Temp', content: 'x' }) as { id: string }

    const removed = await run(memoryForgetFactory.build(ctx), { id: saved.id }) as { ok: boolean }
    expect(removed.ok).toBe(true)

    const again = await run(memoryForgetFactory.build(ctx), { id: saved.id }) as { ok: boolean; error?: string }
    expect(again.ok).toBe(false)
    expect(again.error).toContain('no memory')
  })

  it('memory tools report unavailability instead of throwing when no store is wired', async () => {
    const ctx = { ...ctxFor(store, workspace), memoryStore: undefined }
    const result = await run(memoryRecallFactory.build(ctx), { query: 'x' }) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unavailable')
  })

  it('skill_list reads both skill roots and dedupes', async () => {
    await mkdir(join(workspace, '.claude/skills/smcpro'), { recursive: true })
    await mkdir(join(workspace, '.agents/skills/smcpro'), { recursive: true })
    await mkdir(join(workspace, '.claude/skills/alice'), { recursive: true })
    const body = '---\nname: smcpro\ndescription: Market structure.\n---\n'
    await writeFile(join(workspace, '.claude/skills/smcpro/SKILL.md'), body)
    await writeFile(join(workspace, '.agents/skills/smcpro/SKILL.md'), body)
    await writeFile(join(workspace, '.claude/skills/alice/SKILL.md'), '---\nname: alice\ndescription: CLI.\n---\n')

    const result = await run(skillListFactory.build(ctxFor(store, workspace)), {}) as {
      count: number
      skills: { name: string; description: string }[]
    }
    expect(result.count).toBe(2)
    expect(result.skills.map((skill) => skill.name)).toEqual(['alice', 'smcpro'])
    expect(result.skills.find((skill) => skill.name === 'smcpro')?.description).toBe('Market structure.')
  })

  it('skill_patch updates both copies and refuses an ambiguous find', async () => {
    for (const root of ['.claude/skills', '.agents/skills']) {
      await mkdir(join(workspace, root, 'demo'), { recursive: true })
      await writeFile(join(workspace, root, 'demo/SKILL.md'), '# Demo\n\nstep one\n')
    }

    const patched = await run(skillPatchFactory.build(ctxFor(store, workspace)), {
      name: 'demo',
      find: 'step one',
      replace: 'step one (confirmed)',
    }) as { ok: boolean }
    expect(patched.ok).toBe(true)

    for (const root of ['.claude/skills', '.agents/skills']) {
      const text = await readFile(join(workspace, root, 'demo/SKILL.md'), 'utf-8')
      expect(text).toContain('step one (confirmed)')
    }

    await writeFile(join(workspace, '.claude/skills/demo/SKILL.md'), 'dup dup\n')
    await writeFile(join(workspace, '.agents/skills/demo/SKILL.md'), 'dup dup\n')
    const ambiguous = await run(skillPatchFactory.build(ctxFor(store, workspace)), {
      name: 'demo',
      find: 'dup',
      replace: 'x',
    }) as { ok: boolean; error?: string }
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error).toContain('more than once')
  })

  it('skill_patch reports a missing skill rather than creating one', async () => {
    const result = await run(skillPatchFactory.build(ctxFor(store, workspace)), {
      name: 'nope',
      find: 'a',
      replace: 'b',
    }) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })
})
