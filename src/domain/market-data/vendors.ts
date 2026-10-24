/**
 * Market-vendor catalog — the agent-facing "what data sources do I have, and
 * how do I drive them" surface.
 *
 * Each vendor OWNS its self-description: the prose (coverage + howToUse) lives on
 * the embedded Provider's `vendorMeta`, so adding a vendor carries its own
 * usage note — there is no outer table to forget to update. This module only
 * JOINS that self-description to runtime state read fresh from market-data.json:
 *
 *   - alwaysOn  — is this the primary equity vendor (yfinance)? can't be toggled.
 *   - enabled   — always-on, or present in extraVendors.
 *   - keyless   — derived from the provider's declared credentials.
 *
 * `setMarketVendor` flips extraVendors; because the resolver re-reads config per
 * request, an agent that enables a vendor here can search it on the very next
 * call — no restart. This is the discoverability loop: list → read the usage
 * note → enable the one you need → query.
 */

import type { QueryExecutor } from '@traderalice/opentypebb'
import { readMarketDataConfig, readTvFeedConfig, updateExtraVendors } from '@/core/config.js'

export interface MarketVendorInfo {
  /** Vendor id used everywhere (search sourceId, setMarketVendor arg). */
  id: string
  /** Human display name. */
  name: string
  /** On right now — searches will fan out to it. */
  enabled: boolean
  /** The primary equity vendor: always on, cannot be toggled off. */
  alwaysOn: boolean
  /** No API key required. */
  keyless: boolean
  /** What markets / instruments it covers. */
  coverage: string
  /** How to drive it (symbol convention, search-language quirks). */
  howToUse: string
  website?: string
}

/**
 * The TradingView live feed, described in the same vocabulary as a vendor.
 *
 * It is NOT an embedded OpenTypeBB provider and cannot be toggled through
 * `setMarketVendor`, so it is reported separately — but it MUST be reported,
 * or an agent that inspects its data sources concludes no live feed exists and
 * tells the user its watchers are on a delayed vendor when they are not.
 */
export interface LiveFeedInfo {
  /** Not a search vendor id; this is the live-price overlay. */
  kind: 'live-price-overlay'
  enabled: boolean
  /** Asset classes it serves. Outside these, the delayed vendor still applies. */
  assetClasses: string[]
  /** How a watcher opts in — no symbol change is needed. */
  howToUse: string
  /** Honest statement of what happens when it is off or disconnected. */
  fallback: string
}

/** Describe the TradingView live feed for the discovery surface. */
export async function describeLiveFeed(): Promise<LiveFeedInfo> {
  const tv = await readTvFeedConfig()
  return {
    kind: 'live-price-overlay',
    enabled: tv.enabled,
    assetClasses: [...tv.assetClasses],
    howToUse:
      'Watchers on these asset classes are priced from real-time push data automatically. ' +
      'Do NOT change the pair syntax or ask for a special symbol; write the normal ' +
      'exchange-native pair (crypto `BTC-USDT`) or forex form (`EURUSD=X`).',
    fallback:
      'When disabled, disconnected, or stale, watchers transparently fall back to the delayed ' +
      'federated vendor feed. Equity, commodity, and index watchers always use that feed.',
  }
}

/** Every provider that has opted into the vendor picker (declared `vendorMeta`),
 *  joined to current on/off state. Always-on first, then enabled, then the rest. */
export async function listMarketVendors(executor: QueryExecutor): Promise<MarketVendorInfo[]> {
  const md = await readMarketDataConfig()
  const primary = md.providers.equity
  const extra = new Set(md.extraVendors)

  return executor
    .listProviders()
    .filter((p) => p.vendorMeta)
    .map((p): MarketVendorInfo => {
      const alwaysOn = p.name === primary
      return {
        id: p.name,
        name: p.reprName ?? p.name,
        alwaysOn,
        enabled: alwaysOn || extra.has(p.name),
        keyless: p.credentials.length === 0,
        coverage: p.vendorMeta!.coverage,
        howToUse: p.vendorMeta!.howToUse,
        website: p.website,
      }
    })
    .sort(
      (a, b) =>
        Number(b.alwaysOn) - Number(a.alwaysOn) ||
        Number(b.enabled) - Number(a.enabled) ||
        a.id.localeCompare(b.id),
    )
}

export interface SetVendorResult {
  id: string
  enabled: boolean
  /** The full catalog after the change, so the caller sees the new state. */
  vendors: MarketVendorInfo[]
}

/**
 * Turn a vendor on/off and persist it. Takes effect on the next search (no
 * restart). Rejects unknown ids and the always-on primary.
 */
export async function setMarketVendor(
  executor: QueryExecutor,
  id: string,
  enabled: boolean,
): Promise<SetVendorResult> {
  const known = executor.listProviders().filter((p) => p.vendorMeta)
  const target = known.find((p) => p.name.toLowerCase() === id.trim().toLowerCase())
  if (!target) {
    const names = known.map((p) => p.name).join(', ')
    throw new Error(`Unknown market vendor "${id}". Available vendors: ${names}.`)
  }

  const md = await readMarketDataConfig()
  if (target.name === md.providers.equity) {
    throw new Error(
      `"${target.name}" is the always-on primary equity vendor and cannot be toggled.`,
    )
  }

  await updateExtraVendors((current) =>
    enabled ? [...current, target.name] : current.filter((v) => v !== target.name),
  )

  return { id: target.name, enabled, vendors: await listMarketVendors(executor) }
}
