import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import type { ExternalMcpServerConfig } from '../../core/config.js'
import { ToolCenter } from '../../core/tool-center.js'
import type { Logger } from '../../workspaces/logger.js'

import { ExternalMcpManager } from './index.js'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  event: () => {},
  child: () => silentLogger,
} as unknown as Logger

const fixturePath = fileURLToPath(new URL('./fixture-server.mjs', import.meta.url))

function serverConfig(overrides: Partial<ExternalMcpServerConfig> = {}): ExternalMcpServerConfig {
  return {
    id: 'fixture',
    name: 'Fixture',
    command: process.execPath,
    args: [fixturePath],
    env: {},
    enabled: true,
    ...overrides,
  }
}

let manager: ExternalMcpManager | null = null

afterEach(async () => {
  await manager?.stop()
  manager = null
})

describe('ExternalMcpManager', () => {
  it('does nothing when no servers are enabled', async () => {
    const toolCenter = new ToolCenter()
    manager = new ExternalMcpManager(toolCenter, silentLogger)

    await manager.start([serverConfig({ enabled: false })])
    expect(toolCenter.list()).toEqual([])
    expect(manager.describe()).toEqual([])
  })

  it('connects, registers prefixed tools, and calls them', async () => {
    const toolCenter = new ToolCenter()
    manager = new ExternalMcpManager(toolCenter, silentLogger)

    await manager.start([serverConfig()])

    expect(toolCenter.list()).toContain('mcp__fixture__echo')
    expect(toolCenter.list()).toContain('mcp__fixture__add')
    expect(manager.describe()).toEqual([{ id: 'fixture', tools: 2 }])

    const echo = toolCenter.get('mcp__fixture__echo')
    expect(echo).not.toBeNull()
    const echoResult = await echo!.execute!(
      { message: 'hello' },
      { toolCallId: 't1', messages: [] },
    )
    expect(echoResult).toBe('echo:hello')

    const add = toolCenter.get('mcp__fixture__add')
    const addResult = await add!.execute!(
      { a: 2, b: 3 },
      { toolCallId: 't2', messages: [] },
    )
    expect(addResult).toBe('5')
  })

  it('records the group so Settings → Tools can attribute the tools', async () => {
    const toolCenter = new ToolCenter()
    manager = new ExternalMcpManager(toolCenter, silentLogger)

    await manager.start([serverConfig()])
    expect(toolCenter.getGroup('mcp__fixture__echo')).toBe('external-mcp:fixture')
  })

  it('skips a server whose command cannot be spawned without failing the batch', async () => {
    const toolCenter = new ToolCenter()
    manager = new ExternalMcpManager(toolCenter, silentLogger)

    await manager.start([
      serverConfig({ id: 'broken', command: '/definitely/not/a/real/binary' }),
      serverConfig(),
    ])

    // The healthy server still registered its tools.
    expect(toolCenter.list()).toContain('mcp__fixture__echo')
    expect(manager.describe().map((s) => s.id)).toEqual(['fixture'])
  })

  it('surfaces a bad call as a value instead of throwing into the agent loop', async () => {
    const toolCenter = new ToolCenter()
    manager = new ExternalMcpManager(toolCenter, silentLogger)
    await manager.start([serverConfig()])

    const add = toolCenter.get('mcp__fixture__add')!
    // Wrong argument type: rejected at the protocol boundary. The manager is
    // deliberately fail-soft, so this must resolve with the error text rather
    // than throw and abort the whole agent turn.
    const result = await add.execute!(
      { a: 'nope', b: 3 } as unknown as { a: number; b: number },
      { toolCallId: 't3', messages: [] },
    )
    expect(String(result)).toMatch(/invalid|error/i)
  })
})
