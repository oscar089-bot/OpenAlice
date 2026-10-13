import { describe, it, expect } from 'vitest'

import { migrateDefaultCryptoVendor, type JsonStore } from './0045_default_crypto_vendor/index.js'

/** In-memory JsonStore so the migration is exercised without touching disk. */
function store(initial: Record<string, unknown> | undefined) {
  const writes: Record<string, unknown> = {}
  const files: Record<string, unknown> = initial ? { 'market-data.json': initial } : {}
  const api: JsonStore = {
    async readJson<T>(filename: string) {
      return files[filename] as T | undefined
    },
    async writeJson(filename: string, data: unknown) {
      writes[filename] = data
      files[filename] = data
    },
  }
  return { api, writes }
}

describe('0045 default crypto vendor migration', () => {
  it('appends okx to an existing list and preserves every other field', async () => {
    const s = store({
      enabled: true,
      providers: { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance', commodity: 'yfinance' },
      extraVendors: ['eastmoney'],
      hub: { enabled: false, baseUrl: 'https://example.test' },
    })

    await migrateDefaultCryptoVendor(s.api)

    expect(s.writes['market-data.json']).toEqual({
      enabled: true,
      providers: { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance', commodity: 'yfinance' },
      extraVendors: ['eastmoney', 'okx'],
      hub: { enabled: false, baseUrl: 'https://example.test' },
    })
  })

  it('seeds okx into an explicit empty list', async () => {
    const s = store({ extraVendors: [] })
    await migrateDefaultCryptoVendor(s.api)
    expect(s.writes['market-data.json']).toEqual({ extraVendors: ['okx'] })
  })

  it('is idempotent — a second run writes nothing', async () => {
    const s = store({ extraVendors: [] })
    await migrateDefaultCryptoVendor(s.api)
    await migrateDefaultCryptoVendor(s.api)
    expect(s.writes['market-data.json']).toEqual({ extraVendors: ['okx'] })
    expect(s.writes).toHaveProperty('market-data.json')
  })

  it('is a no-op when the file is absent (fresh home seeds the schema default)', async () => {
    const s = store(undefined)
    await migrateDefaultCryptoVendor(s.api)
    expect(s.writes).toEqual({})
  })

  it('is a no-op when extraVendors is unset (zod default already supplies okx)', async () => {
    const s = store({ enabled: true })
    await migrateDefaultCryptoVendor(s.api)
    expect(s.writes).toEqual({})
  })

  it('is a no-op when okx is already present in the list', async () => {
    const s = store({ extraVendors: ['okx', 'twse'] })
    await migrateDefaultCryptoVendor(s.api)
    expect(s.writes).toEqual({})
  })

  it('rejects a malformed preference list instead of discarding it', async () => {
    await expect(migrateDefaultCryptoVendor(store({ extraVendors: 'okx' }).api)).rejects.toThrow(/array of strings/)
    await expect(migrateDefaultCryptoVendor(store({ extraVendors: [1] }).api)).rejects.toThrow(/array of strings/)
  })

  it('does not write when it rejects a malformed list', async () => {
    const s = store({ extraVendors: 'okx' })
    await expect(migrateDefaultCryptoVendor(s.api)).rejects.toThrow()
    expect(s.writes).toEqual({})
  })
})
