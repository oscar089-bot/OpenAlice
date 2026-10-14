// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MarketDataPage } from './MarketDataPage'

const mocks = vi.hoisted(() => ({
  hubStatus: vi.fn(),
  testProvider: vi.fn(),
  updateConfig: vi.fn(),
  updateConfigImmediate: vi.fn(),
  retry: vi.fn(),
  /** Mirrors the shipped `extraVendors` default so the chart-vendor rows are
   *  exercised against the same seed a fresh install gets. */
  extraVendors: ['okx'] as string[],
}))

vi.mock('../api', () => ({
  api: {
    trading: {
      loadTradingConfig: vi.fn().mockResolvedValue({ utas: [] }),
    },
    marketData: {
      hubStatus: mocks.hubStatus,
      testProvider: mocks.testProvider,
    },
  },
}))

vi.mock('../hooks/useConfigPage', () => ({
  useConfigPage: () => ({
    get config() {
      return {
        enabled: true,
        hub: { enabled: false, baseUrl: 'https://traderhub.openalice.ai' },
        extraVendors: mocks.extraVendors,
        providerKeys: {
          fmp: 'test-fmp-key',
          fred: 'test-fred-key',
          bls: 'test-bls-key',
          eia: 'test-eia-key',
          econdb: 'test-econdb-key',
          intrinio: 'test-intrinio-key',
        },
      }
    },
    status: 'idle',
    loadError: false,
    updateConfig: mocks.updateConfig,
    updateConfigImmediate: mocks.updateConfigImmediate,
    retry: mocks.retry,
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.extraVendors = ['okx']
  mocks.testProvider.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

function openProviderKeys() {
  render(<MarketDataPage />)
  fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
}

/** Chart-vendor rows render on the page itself — no Advanced disclosure. */
function openChartVendors() {
  render(<MarketDataPage />)
}

describe('MarketDataPage provider credentials', () => {
  it('gives every key field and test action a provider-specific name', () => {
    openProviderKeys()

    for (const provider of ['FMP', 'FRED', 'BLS', 'EIA', 'EconDB', 'Intrinio']) {
      const input = screen.getByLabelText(`${provider} API key`)
      expect(screen.getByText(provider, { selector: 'label' }).getAttribute('for'))
        .toBe(input.getAttribute('id'))
      expect(input.getAttribute('aria-describedby')).toBe(
        `market-data-provider-${provider.toLowerCase()}-key-description ` +
        `market-data-provider-${provider.toLowerCase()}-key-hint ` +
        `market-data-provider-${provider.toLowerCase()}-key-test-status`,
      )
      expect(screen.getByRole('button', { name: `Test ${provider} key` })).toBeTruthy()
    }
  })

  it('associates provider test progress and success with the matching field', async () => {
    let finishTest: ((result: { ok: boolean }) => void) | undefined
    mocks.testProvider.mockReturnValueOnce(new Promise((resolve) => {
      finishTest = resolve
    }))
    openProviderKeys()

    fireEvent.click(screen.getByRole('button', { name: 'Test FMP key' }))

    expect(await screen.findByRole('button', { name: 'Testing FMP key' })).toBeTruthy()
    expect(screen.getByText('Testing FMP key').getAttribute('id'))
      .toBe('market-data-provider-fmp-key-test-status')

    finishTest?.({ ok: true })

    expect(await screen.findByRole('button', { name: 'FMP key test passed' })).toBeTruthy()
    expect(screen.getByText('FMP key test passed').getAttribute('id'))
      .toBe('market-data-provider-fmp-key-test-status')
  })

  it('announces a failed provider test without changing another provider action', async () => {
    mocks.testProvider.mockResolvedValueOnce({ ok: false })
    openProviderKeys()

    fireEvent.click(screen.getByRole('button', { name: 'Test BLS key' }))

    expect(await screen.findByRole('button', { name: 'BLS key test failed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Test FRED key' })).toBeTruthy()
  })
})

describe('MarketDataPage chart vendors', () => {
  it('shows the seeded crypto vendor as on and keeps the other regional vendors off', () => {
    openChartVendors()

    // okx ships enabled via the `extraVendors` seed, so exchange-native crypto
    // resolves out of the box while eastmoney/twse stay opt-in.
    expect(screen.getByLabelText('OKX').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Eastmoney 东方财富').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByLabelText('TWSE + TPEx 臺灣證交所').getAttribute('aria-checked')).toBe('false')
  })

  it('turning okx off removes exactly that vendor, leaving the rest untouched', () => {
    openChartVendors()

    fireEvent.click(screen.getByLabelText('OKX'))

    expect(mocks.updateConfigImmediate).toHaveBeenCalledWith({ extraVendors: [] })
  })

  it('turning a regional vendor on appends it without dropping the seeded vendor', () => {
    openChartVendors()

    fireEvent.click(screen.getByLabelText('TWSE + TPEx 臺灣證交所'))

    expect(mocks.updateConfigImmediate).toHaveBeenCalledWith({ extraVendors: ['okx', 'twse'] })
  })

  it('leaves the always-on primary vendor untogglable', () => {
    openChartVendors()

    // yfinance is the always-on global default: it renders a label, not a switch.
    expect(screen.queryByLabelText('yfinance')).toBeNull()
    expect(screen.getByText('Always on')).toBeTruthy()
  })
})
