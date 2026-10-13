/**
 * Enabled-vendor resolution — the ONE place that decides which market-data
 * vendors a search fans out to, per asset class.
 *
 * Two rules, both anchored in `market-data.json` plus each provider's declared
 * capabilities, so the vendor picker (`listMarketVendors` / `setMarketVendor`)
 * and the search fan-out can never disagree:
 *
 *   1. Enabled = the per-class primary (always on) union the user-toggleable
 *      `extraVendors` list. `extraVendors` is seeded with the keyless `okx`
 *      exchange feed so exchange-native crypto symbols resolve out of the box;
 *      turning a vendor off removes it from `extraVendors`, the same edit the
 *      picker and `setMarketVendor` already perform. No second list, no hidden
 *      injection in the boot path.
 *
 *   2. Capability filter — a vendor only joins an asset class it can actually
 *      serve (its provider declares that class's search model). This is what
 *      lets a crypto-only vendor (`okx`) live in the shared `extraVendors`
 *      list without ever being fanned into equity search (`okx` has no
 *      `EquitySearch` fetcher), and keeps a regional equity vendor
 *      (`eastmoney`, `twse`) out of crypto search.
 */

import type { QueryExecutor } from '@traderalice/opentypebb'

/** Standard-model name each asset class searches through. */
const SEARCH_MODEL = {
  equity: 'EquitySearch',
  crypto: 'CryptoSearch',
  currency: 'CurrencyPairs',
  commodity: 'CommoditySpotPrice',
} as const

export type VendorAssetClass = keyof typeof SEARCH_MODEL

/** Minimal view of the market-data config the resolver needs. */
export interface EnabledVendorConfigView {
  providers: Record<VendorAssetClass, string>
  /** User-toggleable vendors beyond the per-class primary (seeded with `okx`). */
  extraVendors: string[]
}

/** Does `provider` declare the search fetcher for `assetClass`? */
export function servesAssetClass(
  executor: QueryExecutor,
  provider: string,
  assetClass: VendorAssetClass,
): boolean {
  try {
    return Boolean(executor.getProvider(provider).fetcherDict[SEARCH_MODEL[assetClass]])
  } catch {
    return false
  }
}

/**
 * The per-class enabled vendor list: `[primary, ...extraVendors]`, de-duped and
 * filtered to vendors that actually serve the class. The primary is always
 * first so it stays the default identity for that class.
 */
export function resolveEnabledVendors(
  executor: QueryExecutor,
  md: EnabledVendorConfigView,
  assetClass: VendorAssetClass,
): string[] {
  const primary = md.providers[assetClass]
  const candidates = [...new Set([primary, ...md.extraVendors])]
  return candidates.filter((v) => servesAssetClass(executor, v, assetClass))
}
