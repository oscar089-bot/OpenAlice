import type { Migration } from '../types.js'

/**
 * Seed the keyless OKX crypto vendor into `extraVendors` for homes whose
 * `market-data.json` predates the new default.
 *
 * Why a migration is needed: `extraVendors` is a shipped, persisted array, and
 * `parseAndSeed` only applies schema defaults when the file is ABSENT. Every
 * existing home already has an explicit `extraVendors: []` written to disk, so
 * raising the schema default to `['okx']` only reaches fresh installs — the
 * picker (`listMarketVendors`) and the search fan-out would then disagree with
 * a fresh install about whether OKX is on.
 *
 * Boundary discipline: this deliberately does NOT import the evolving config
 * schema. `market-data.json` is user-editable and read by several processes, so
 * the migration touches exactly one key and spreads every other field back
 * verbatim, letting the file's own shape survive independent of future schema
 * drift.
 */

/**
 * The vendor to enable. Mirrors `DEFAULT_EXTRA_VENDORS` in `src/core/config.ts`;
 * duplicated on purpose so the frozen migration never tracks a moving constant.
 */
const DEFAULT_CRYPTO_VENDOR = 'okx'

/** Minimal JSON view of the migration context — keeps the spec free of the
 *  full {@link MigrationContext} surface. */
export interface JsonStore {
  readJson<T = unknown>(filename: string): Promise<T | undefined>
  writeJson(filename: string, data: unknown): Promise<void>
}

export async function migrateDefaultCryptoVendor(store: JsonStore): Promise<void> {
  const raw = await store.readJson<Record<string, unknown>>('market-data.json')
  // Missing file → a fresh home. `parseAndSeed` will write the new default.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return

  const current = raw['extraVendors']
  // Absent key → the zod default already supplies the vendor at read time.
  if (current === undefined) return
  if (!Array.isArray(current) || current.some((v) => typeof v !== 'string')) {
    // Never rewrite a malformed preference list — surface it instead of
    // discarding whatever the user (or a future version) put there.
    throw new Error('market-data.json `extraVendors` must be an array of strings')
  }

  // Idempotent: append only when absent, so a re-run after a lost journal is a
  // no-op and a deliberate user removal is never resurrected mid-list.
  if (current.includes(DEFAULT_CRYPTO_VENDOR)) return
  await store.writeJson('market-data.json', {
    ...raw,
    extraVendors: [...current, DEFAULT_CRYPTO_VENDOR],
  })
}

export const migration: Migration = {
  id: '0045_default_crypto_vendor',
  appVersion: '0.93.2-beta',
  introducedAt: '2026-09-28',
  affects: ['data/config/market-data.json'],
  summary:
    'Seed the keyless okx crypto vendor into extraVendors so exchange-native symbols resolve by default; no-op when already present, unset, or absent.',
  up: async (ctx) => migrateDefaultCryptoVendor(ctx),
}
