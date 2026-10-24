/**
 * Probe one external MCP server without registering anything.
 *
 * Backs the "Test" button in Settings → MCP Server: the operator pastes a
 * command, proves it works, and only then adds it. Deliberately separate from
 * `ExternalMcpManager`, which owns the long-lived connections — a probe creates
 * its own client, lists tools, and always tears everything down.
 *
 * Never throws: every failure becomes `{ ok: false, error }` so the route stays
 * a plain JSON handler.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import type { ExternalMcpServerConfig } from '../../core/config.js'

export interface ExternalMcpProbeResult {
  ok: boolean
  /** Tool names the server exposes, in its own namespace. */
  tools?: Array<{ name: string; description?: string }>
  /** Server-reported name/version, when it supplies one. */
  server?: { name?: string; version?: string }
  error?: string
}

/** Ceiling for connect + listTools. Matches the manager's boot ceiling. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Connect, list tools, disconnect.
 *
 * `id`/`name` are not required for a probe — the operator is testing a command
 * before naming it. Only the spawn fields matter here.
 */
export async function probeExternalMcpServer(
  config: Pick<ExternalMcpServerConfig, 'command' | 'args' | 'env' | 'cwd'>,
): Promise<ExternalMcpProbeResult> {
  const command = config.command?.trim()
  if (!command) return { ok: false, error: 'Command is required.' }

  const transport = new StdioClientTransport({
    command,
    args: [...(config.args ?? [])],
    // Merged on top of the SDK's default inherited env (HOME, PATH, …), so
    // `uv`/`npx` resolve exactly as they will at boot.
    env: { ...(config.env ?? {}) },
    ...(config.cwd ? { cwd: config.cwd } : {}),
    stderr: 'pipe',
  })

  const client = new Client(
    { name: 'open-alice:probe', version: '1.0.0' },
    { capabilities: {} },
  )

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const connectAndList = (async () => {
      await client.connect(transport)
      const listed = await client.listTools()
      return listed
    })()

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`No response within ${PROBE_TIMEOUT_MS / 1000}s.`)),
        PROBE_TIMEOUT_MS,
      )
      timer.unref?.()
    })

    const listed = await Promise.race([connectAndList, timeout])

    const serverInfo = client.getServerVersion()
    return {
      ok: true,
      tools: listed.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
      })),
      ...(serverInfo
        ? { server: { ...(serverInfo.name ? { name: serverInfo.name } : {}), ...(serverInfo.version ? { version: serverInfo.version } : {}) } }
        : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
    // A failed connect can leave a spawned child behind; close both, and never
    // let teardown mask the real result.
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
  }
}
