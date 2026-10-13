/**
 * Enabled-vendor resolution — proven against the REAL provider registry, because
 * the whole point of the capability filter is that it agrees with what each
 * provider actually declares. A stubbed executor could pass while the shipped
 * providers disagree.
 */
import { describe, expect, it } from 'vitest'

import { getSDKExecutor } from '@/domain/market-data/client/typebb/executor.js'

import { resolveEnabledVendors, servesAssetClass } from './enabled-vendors.js'

const executor = getSDKExecutor()

const BASE = {
  providers: { equity: 'yfinance', crypto: 'yfinance', currency: 'yfinance', commodity: 'yfinance' },
  extraVendors: ['okx'],
}

describe('servesAssetClass', () => {
  it('reads the provider\u2019s declared search fetcher', () => {
    expect(servesAssetClass(executor, 'okx', 'crypto')).toBe(true)
    expect(servesAssetClass(executor, 'okx', 'equity')).toBe(false)
    expect(servesAssetClass(executor, 'eastmoney', 'equity')).toBe(true)
    expect(servesAssetClass(executor, 'eastmoney', 'crypto')).toBe(false)
  })

  it('treats an unknown provider as not serving anything', () => {
    expect(servesAssetClass(executor, 'not-a-vendor', 'equity')).toBe(false)
  })
})

describe('resolveEnabledVendors', () => {
  it('keeps the primary first and adds only vendors that serve the class', () => {
    // okx is crypto-only: it joins crypto but must never leak into equity.
    expect(resolveEnabledVendors(executor, BASE, 'crypto')).toEqual(['yfinance', 'okx'])
    expect(resolveEnabledVendors(executor, BASE, 'equity')).toEqual(['yfinance'])
  })

  it('drops an equity-only vendor from crypto search', () => {
    const md = { ...BASE, extraVendors: ['okx', 'eastmoney', 'twse'] }
    expect(resolveEnabledVendors(executor, md, 'crypto')).toEqual(['yfinance', 'okx'])
    expect(resolveEnabledVendors(executor, md, 'equity')).toEqual(['yfinance', 'eastmoney', 'twse'])
  })

  it('de-dupes when a vendor is both the primary and an extra', () => {
    const md = { ...BASE, extraVendors: ['yfinance', 'okx'] }
    expect(resolveEnabledVendors(executor, md, 'crypto')).toEqual(['yfinance', 'okx'])
  })

  it('turns okx off by removing it from extraVendors \u2014 no hidden injection', () => {
    const md = { ...BASE, extraVendors: [] }
    expect(resolveEnabledVendors(executor, md, 'crypto')).toEqual(['yfinance'])
  })

  it('honours a non-default crypto primary', () => {
    const md = {
      providers: { ...BASE.providers, crypto: 'okx' },
      extraVendors: [],
    }
    expect(resolveEnabledVendors(executor, md, 'crypto')).toEqual(['okx'])
  })
})
