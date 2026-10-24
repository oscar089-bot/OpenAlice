/**
 * External MCP client manager.
 *
 * Connects Alice to user-configured third-party MCP servers as a CLIENT and
 * re-exports their tools through the normal `ToolCenter`. This is the mirror
 * image of `src/server/mcp.ts`, which EXPORTS Alice's tools to other clients.
 *
 * Lifecycle: `start()` connects every enabled server; `stop()` closes them all.
 * A server that fails to start is logged and skipped — one broken external
 * server must never prevent Alice from booting or block the others.
 *
 * Tool naming: `mcp__<serverId>__<toolName>`. The prefix makes provenance
 * obvious to the agent and the group column in Settings → Tools, and lets
 * `stop()`/removal cleanly identify what a server contributed.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { tool } from 'ai'
import type { Tool } from 'ai'

import type { ExternalMcpServerConfig } from '../../core/config.js'
import type { ToolCenter } from '../../core/tool-center.js'
import type { Logger } from '../../workspaces/logger.js'

import { jsonSchemaToZod } from './json-schema-to-zod.js'

/** Ceiling on one server's connect + listTools. A hung or misconfigured
 *  external server must never delay Alice's boot indefinitely. */
const CONNECT_TIMEOUT_MS = 15_000

/** One live connection plus the tool names it contributed. */
interface ConnectedServer {
  config: ExternalMcpServerConfig
  client: Client
  transport: StdioClientTransport
  toolNames: string[]
}

/** Convert one remote tool result into a plain JSON-serializable payload. */
function toPlainResult(result: unknown): unknown {
  if (result == null || typeof result !== 'object') return result
  const record = result as Record<string, unknown>
  const content = record['content']
  if (!Array.isArray(content)) return result

  const texts: string[] = []
  const others: unknown[] = []
  for (const block of content) {
    if (
      block && typeof block === 'object' &&
      (block as Record<string, unknown>)['type'] === 'text' &&
      typeof (block as Record<string, unknown>)['text'] === 'string'
    ) {
      texts.push((block as Record<string, unknown>)['text'] as string)
    } else {
      others.push(block)
    }
  }

  if (others.length === 0 && texts.length === 1) return texts[0]
  if (others.length === 0) return { text: texts.join('\n') }
  return { text: texts.join('\n'), content: others }
}

/**
 * Owns the external-MCP connections and their tool registrations.
 *
 * Construction is inert; nothing spawns until `start()`. That matters because
 * `main.ts` builds this before the runtime lock is fully exercised and a failed
 * spawn should not be part of the boot path.
 */
export class ExternalMcpManager {
  private readonly connected = new Map<string, ConnectedServer>()

  constructor(
    private readonly toolCenter: ToolCenter,
    private readonly logger: Logger,
  ) {}

  /** Connect every enabled server. Never throws. */
  async start(servers: readonly ExternalMcpServerConfig[]): Promise<void> {
    const enabled = servers.filter((s) => s.enabled)
    if (enabled.length === 0) return

    const results = await Promise.allSettled(
      enabled.map((s) => this.withTimeout(this.connectOne(s), s)),
    )
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        const server = enabled[index]!
        this.logger.warn('external_mcp.connect_failed', {
          id: server.id,
          err: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }

    if (this.connected.size > 0) {
      this.logger.info('external_mcp.ready', {
        servers: [...this.connected.keys()],
        tools: [...this.connected.values()].reduce((n, s) => n + s.toolNames.length, 0),
      })
    }
  }

  /** Reject rather than hang when a server never completes the handshake. */
  private withTimeout(promise: Promise<void>, config: ExternalMcpServerConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS}ms connecting to "${config.id}"`))
      }, CONNECT_TIMEOUT_MS)
      timer.unref?.()
      promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (err) => { clearTimeout(timer); reject(err) },
      )
    })
  }

  private async connectOne(config: ExternalMcpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      // Merged ON TOP of the SDK's default inherited environment (HOME, PATH,
      // SHELL, …), so `npx`/`uv` still resolve while user vars are additive.
      env: { ...config.env },
      ...(config.cwd ? { cwd: config.cwd } : {}),
      // Piped so a noisy server cannot interleave with Alice's stdout, which
      // carries the MCP protocol on its own listener.
      stderr: 'pipe',
    })

    const client = new Client(
      { name: `open-alice:${config.id}`, version: '1.0.0' },
      { capabilities: {} },
    )

    await client.connect(transport)

    const listed = await client.listTools()
    const registered: Record<string, Tool> = {}
    const toolNames: string[] = []

    for (const remote of listed.tools) {
      const name = `mcp__${config.id}__${remote.name}`
      const description = remote.description ?? `${config.name}: ${remote.name}`
      const inputSchema = jsonSchemaToZod(remote.inputSchema)

      registered[name] = tool({
        description,
        inputSchema,
        execute: async (args: Record<string, unknown>) => {
          try {
            const result = await client.callTool({
              name: remote.name,
              arguments: args ?? {},
            })
            return toPlainResult(result)
          } catch (err) {
            return {
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        },
      })
      toolNames.push(name)
    }

    if (toolNames.length > 0) {
      this.toolCenter.register(registered, `external-mcp:${config.id}`)
    }
    this.connected.set(config.id, { config, client, transport, toolNames })
    this.logger.info('external_mcp.connected', { id: config.id, tools: toolNames.length })
  }

  /** Close every connection. Idempotent; never throws. */
  async stop(): Promise<void> {
    const entries = [...this.connected.values()]
    this.connected.clear()
    await Promise.allSettled(entries.map(async (entry) => {
      try {
        await entry.client.close()
      } catch {
        // The transport is already gone; nothing to recover.
      }
      try {
        await entry.transport.close()
      } catch {
        // Same.
      }
    }))
  }

  /** Connected server ids with their contributed tool counts (for the UI). */
  describe(): Array<{ id: string; tools: number }> {
    return [...this.connected.values()].map((entry) => ({
      id: entry.config.id,
      tools: entry.toolNames.length,
    }))
  }
}
