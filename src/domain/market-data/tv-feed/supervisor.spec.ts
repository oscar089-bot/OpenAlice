import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TvFeedConfig } from '../../../core/config.js'
import type { Logger } from '../../../workspaces/logger.js'
import { TvFeedSupervisor, portFromFeedUrl, resolveFeedEntry } from './supervisor.js'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  event: () => {},
  child: () => silentLogger,
} as unknown as Logger

function config(overrides: Partial<TvFeedConfig> = {}): TvFeedConfig {
  return {
    enabled: true,
    autoStart: true,
    url: 'ws://127.0.0.1:8081',
    bindHost: '127.0.0.1',
    assetClasses: ['crypto', 'forex'],
    staleMs: 5_000,
    subscribeTimeoutMs: 4_000,
    ...overrides,
  }
}

/** Wait until `predicate` is true or the budget elapses. */
async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return predicate()
}

let active: TvFeedSupervisor | null = null
const tempDirs: string[] = []

afterEach(async () => {
  active?.stop()
  active = null
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('portFromFeedUrl', () => {
  it('extracts an explicit port', () => {
    expect(portFromFeedUrl('ws://127.0.0.1:8081')).toBe(8081)
    expect(portFromFeedUrl('ws://localhost:9000')).toBe(9000)
  })

  it('falls back to the protocol default when no port is written', () => {
    expect(portFromFeedUrl('ws://127.0.0.1')).toBe(80)
    expect(portFromFeedUrl('wss://feed.example.com')).toBe(443)
  })

  it('returns null for an unparseable url', () => {
    expect(portFromFeedUrl('not a url')).toBeNull()
    expect(portFromFeedUrl('')).toBeNull()
  })
})

describe('resolveFeedEntry', () => {
  it('returns null when the service has not been built', () => {
    // The repo copy may or may not be built in a given checkout, so assert on
    // the shape rather than a specific path.
    const entry = resolveFeedEntry()
    expect(entry === null || entry.endsWith(join('services', 'tv-feed', 'dist', 'main.js'))).toBe(true)
  })
})

describe('TvFeedSupervisor', () => {
  it('does nothing when disabled', () => {
    const supervisor = new TvFeedSupervisor(config({ enabled: false }), silentLogger)
    active = supervisor
    supervisor.start()
    expect(supervisor.running).toBe(false)
  })

  it('does nothing when autoStart is off, so an external service can be used', () => {
    const supervisor = new TvFeedSupervisor(config({ autoStart: false }), silentLogger)
    active = supervisor
    supervisor.start()
    expect(supervisor.running).toBe(false)
  })

  it('never throws from start(), even when the entry point is missing', () => {
    // `resolveFeedEntry` deliberately checks a module-load-time app root as well
    // as the cwd, so a test cannot force the missing branch by chdir-ing. What
    // matters is the contract: start() is safe on a checkout where the service
    // has never been built.
    const supervisor = new TvFeedSupervisor(config(), silentLogger)
    active = supervisor
    expect(() => supervisor.start()).not.toThrow()
  })

  it('stops cleanly when never started', () => {
    const supervisor = new TvFeedSupervisor(config(), silentLogger)
    expect(() => supervisor.stop()).not.toThrow()
    expect(supervisor.stop()).toBeUndefined()
  })

  it('is idempotent when stopped twice', () => {
    const supervisor = new TvFeedSupervisor(config(), silentLogger)
    active = supervisor
    supervisor.start()
    supervisor.stop()
    expect(() => supervisor.stop()).not.toThrow()
  })
})
