import { describe, expect, it, vi } from 'vitest'

import type { Credential } from '../core/config.js'
import { discoveredModels } from './connector-session.js'

/** A self-hosted OpenAI-compatible endpoint: two models, no bundled catalog. */
const customEndpoint: Credential = {
  vendor: 'custom',
  authType: 'api-key',
  label: 'Deepseek',
  apiKey: 'sk-test',
  wires: { 'openai-chat': 'http://127.0.0.1:1/v1' },
}

describe('discoveredModels', () => {
  it('returns the endpoint catalog for a custom credential with no bundled preset models', async () => {
    const read = vi.fn(async () => ({
      models: [
        { id: 'deepseek-chat', label: 'deepseek-chat' },
        { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
      ],
    }))

    // The static preset answer for `vendor: 'custom'` is deliberately empty —
    // this is the exact shape that left step 4 of create with only "Skip".
    const models = await discoveredModels(customEndpoint, [], read)

    expect(models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(read).toHaveBeenCalledOnce()
  })

  it('prefers discovered ids but keeps a known preset label', async () => {
    const read = async () => ({ models: [{ id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' }] })

    const models = await discoveredModels(
      { vendor: 'anthropic', authType: 'api-key', apiKey: 'sk', wires: { anthropic: '' } },
      [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
      read,
    )

    expect(models).toEqual([{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }])
  })

  it('falls back to the static preset list when discovery yields nothing', async () => {
    const models = await discoveredModels(
      customEndpoint,
      [{ id: 'manual-model', label: 'Manual model' }],
      async () => ({ models: [] }),
    )

    expect(models).toEqual([{ id: 'manual-model', label: 'Manual model' }])
  })

  it('degrades to the static list instead of failing when discovery throws', async () => {
    const models = await discoveredModels(
      customEndpoint,
      [{ id: 'manual-model', label: 'Manual model' }],
      async () => { throw new Error('endpoint unreachable') },
    )

    expect(models).toEqual([{ id: 'manual-model', label: 'Manual model' }])
  })

  it('uses the static list for the native runtime login', async () => {
    const read = vi.fn(async () => ({ models: [] }))
    const models = await discoveredModels(null, [{ id: 'composer-2.5', label: 'Composer 2.5' }], read)

    expect(models).toEqual([{ id: 'composer-2.5', label: 'Composer 2.5' }])
    expect(read).not.toHaveBeenCalled()
  })
})
