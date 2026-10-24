import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from './memory-store.js'

describe('parseFrontmatter', () => {
  it('splits the flat frontmatter this store writes', () => {
    const text = '---\nid: abc\ntitle: A title\ntype: feedback\n---\n\nBody text\n'
    const { meta, body } = parseFrontmatter(text)
    expect(meta['id']).toBe('abc')
    expect(meta['title']).toBe('A title')
    expect(meta['type']).toBe('feedback')
    expect(body.trim()).toBe('Body text')
  })

  it('returns the whole text as body when there is no frontmatter', () => {
    const { meta, body } = parseFrontmatter('plain\n')
    expect(meta).toEqual({})
    expect(body).toBe('plain\n')
  })

  it('keeps colons inside a value', () => {
    const { meta } = parseFrontmatter('---\ndescription: wait: confirmed only\n---\n')
    expect(meta['description']).toBe('wait: confirmed only')
  })

  it('treats an unterminated block as body', () => {
    const text = '---\ntitle: nope\n'
    expect(parseFrontmatter(text)).toEqual({ meta: {}, body: text })
  })
})
