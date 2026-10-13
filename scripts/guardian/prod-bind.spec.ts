import { describe, expect, it } from 'vitest'

import {
  resolveProdAdvertisedHost,
  resolveProdBindHost,
  withProdAliceBindHost,
} from './prod-bind.mjs'

describe('built Guardian bind host', () => {
  it('defaults source and Docker runtimes to all interfaces', () => {
    expect(resolveProdBindHost({}, 'docker')).toBe('0.0.0.0')
  })

  it('keeps installed CLI runtimes on loopback by default', () => {
    expect(resolveProdBindHost({}, 'cli')).toBe('127.0.0.1')
    expect(resolveProdBindHost({}, 'cli-server')).toBe('127.0.0.1')
  })

  it('honors an explicit bind host', () => {
    expect(resolveProdBindHost({ OPENALICE_BIND_HOST: '192.0.2.10' }, 'docker'))
      .toBe('192.0.2.10')
  })

  it('advertises loopback instead of the wildcard listener address', () => {
    expect(resolveProdAdvertisedHost('0.0.0.0')).toBe('127.0.0.1')
    expect(resolveProdAdvertisedHost('192.0.2.10')).toBe('192.0.2.10')
  })

  it('passes the resolved listener address to Alice', () => {
    expect(withProdAliceBindHost({ NODE_ENV: 'production' }, '0.0.0.0')).toEqual({
      NODE_ENV: 'production',
      OPENALICE_BIND_HOST: '0.0.0.0',
    })
  })
})