/**
 * MemoryStore behavior contract.
 *
 * These assertions are the ones other subsystems depend on: the index shape
 * injected into prompts, the write-once RULE.md, and the fact that a repeat
 * save overwrites rather than duplicating.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore, DEFAULT_RULE, type IMemoryStore } from './memory-store.js'

describe('MemoryStore', () => {
  let root: string
  let store: IMemoryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openalice-memory-'))
    store = createMemoryStore({ root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates RULE.md with the default rule on first read', async () => {
    const rule = await store.rule()
    expect(rule).toBe(DEFAULT_RULE)
    expect(await readFile(join(root, 'RULE.md'), 'utf-8')).toBe(DEFAULT_RULE)
  })

  it('never overwrites an existing RULE.md', async () => {
    await store.rule()
    const edited = '# my own rules\n'
    await (await import('node:fs/promises')).writeFile(join(root, 'RULE.md'), edited, 'utf-8')
    expect(await store.rule()).toBe(edited)
  })

  it('saves an entry and lists it back with its body intact', async () => {
    const saved = await store.save({
      title: 'BTC watcher timing',
      content: 'A watcher was correct but premature.',
      type: 'feedback',
    })
    expect(saved.type).toBe('feedback')
    expect(saved.body).toContain('premature')

    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.title).toBe('BTC watcher timing')
  })

  it('keeps a sentence-long title out of the filename', async () => {
    const saved = await store.save({
      title: 'always emit real tool calls never just describe them in prose',
      content: 'x',
      type: 'user',
    })
    // Six words, so the file stays readable and linkable instead of becoming
    // `user_always_emit_real_tool_calls_never_just_describe_them_in_prose.md`.
    expect(saved.file.endsWith('user_always_emit_real_tool_calls_never.md')).toBe(true)
  })

  it('collapses whitespace and clips an overlong stored title', async () => {
    const saved = await store.save({
      title: `  two   lines\nand a tab\there ${'x'.repeat(100)}  `,
      content: 'x',
      type: 'project',
    })
    expect(saved.title).not.toContain('\n')
    expect(saved.title).not.toContain('\t')
    expect(saved.title).not.toMatch(/\s{2,}/)
    expect(saved.title.length).toBeLessThanOrEqual(80)
  })

  it('overwrites on the same title+type instead of duplicating', async () => {
    await store.save({ title: 'Discipline', content: 'first', type: 'user' })
    await store.save({ title: 'Discipline', content: 'second', type: 'user' })
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.body).toContain('second')
  })

  it('keeps the same title under two different types as two entries', async () => {
    await store.save({ title: 'Discipline', content: 'as user', type: 'user' })
    await store.save({ title: 'Discipline', content: 'as feedback', type: 'feedback' })
    expect(await store.list()).toHaveLength(2)
  })

  it('rebuilds MEMORY.md as a linked index', async () => {
    await store.save({ title: 'Session open confirmation', content: 'x', type: 'feedback' })
    const index = await readFile(join(root, 'MEMORY.md'), 'utf-8')
    expect(index).toContain('[Session open confirmation]')
    expect(index).toMatch(/\.md\)/)
  })

  it('snapshot returns the index without trailing blank lines', async () => {
    expect(await store.snapshot()).toBe('')
    await store.save({ title: 'Entry one', content: 'x', type: 'project' })
    const snapshot = await store.snapshot()
    expect(snapshot.startsWith('- [Entry one]')).toBe(true)
    expect(snapshot.endsWith('\n')).toBe(false)
  })

  it('blocks an identical write raised immediately after itself', async () => {
    await store.save({ title: 'Dup', content: 'same body', type: 'project' })
    await expect(store.save({ title: 'Dup', content: 'same body', type: 'project' })).rejects.toThrow(
      /Duplicate write blocked/,
    )
  })

  it('searches title, description and body with all tokens required', async () => {
    await store.save({ title: 'EURUSD trap', content: 'not every setup wants a watcher', type: 'feedback' })
    await store.save({ title: 'BTC timing', content: 'wait for confirmation', type: 'feedback' })

    expect((await store.search('eurusd')).map((e) => e.title)).toEqual(['EURUSD trap'])
    expect((await store.search('watcher setup')).map((e) => e.title)).toEqual(['EURUSD trap'])
    expect(await store.search('eurusd confirmation')).toHaveLength(0)
    expect(await store.search('')).toHaveLength(2)
  })

  it('removes by id and by title', async () => {
    const saved = await store.save({ title: 'Temp lesson', content: 'x', type: 'project' })
    expect(await store.remove(saved.id)).toBe(true)
    expect(await store.list()).toHaveLength(0)

    await store.save({ title: 'Temp two', content: 'y', type: 'project' })
    expect(await store.removeByTitle('temp two')).toBe(true)
    expect(await store.list()).toHaveLength(0)
  })

  it('updates an entry in place and preserves createdAt', async () => {
    const saved = await store.save({ title: 'Evolving', content: 'v1', type: 'project' })
    await new Promise((resolve) => setTimeout(resolve, 2))
    const updated = await store.update(saved.id, { body: 'v2' })
    expect(updated?.body).toContain('v2')
    expect(updated?.createdAt).toBe(saved.createdAt)
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(saved.updatedAt)
  })

  it('ignores unrelated files in the memory root', async () => {
    await (await import('node:fs/promises')).writeFile(join(root, 'notes.txt'), 'ignore me', 'utf-8')
    await store.save({ title: 'Real', content: 'x', type: 'project' })
    expect(await store.list()).toHaveLength(1)
  })

  it('leaves no temp files behind', async () => {
    await store.save({ title: 'Clean', content: 'x', type: 'project' })
    const files = await readdir(root)
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})
