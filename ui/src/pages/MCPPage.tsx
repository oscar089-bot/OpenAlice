/**
 * MCP Server settings — separate from external notification connectors.
 *
 * Two directions live here:
 *
 *   1. EXPORT (existing): run a local Streamable HTTP endpoint so external MCP
 *      clients (Claude Desktop, codex inside workspaces) can call Alice's tools.
 *   2. IMPORT (new): connect Alice to third-party MCP servers as a CLIENT and
 *      re-export their tools into Alice's own catalog. Configured servers are
 *      spawned at boot; their tools appear as `mcp__<id>__<tool>`.
 */

import { useState } from 'react'
import { useConfigPage } from '../hooks/useConfigPage'
import { SaveIndicator } from '../components/SaveIndicator'
import { ConfigSection, Field, SettingsScrollArea, inputClass } from '../components/form'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui/button'
import { Toggle } from '../components/Toggle'
import { api, type AppConfig, type ExternalMcpServer, type ExternalMcpProbeResult, type McpConfig } from '../api'

/** Blank draft used by the add form. */
const EMPTY_DRAFT = { id: '', name: '', command: '', args: '', env: '' }
type Draft = typeof EMPTY_DRAFT

/** Parse a `KEY=value` line list into an env map. Blank lines are ignored. */
function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return env
}

/** Derive a stable id from a display name when the user leaves it blank. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function MCPPage() {
  const { config, status, loadError, updateConfig, reload, retry } = useConfigPage<McpConfig>({
    section: 'mcp',
    extract: (full: AppConfig) => full.mcp,
  })
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [formError, setFormError] = useState<string | null>(null)
  /** Result of the last probe, cleared whenever the form changes. */
  const [probe, setProbe] = useState<ExternalMcpProbeResult | null>(null)
  const [probing, setProbing] = useState(false)

  const servers = config?.externalServers ?? []

  const setServers = (next: ExternalMcpServer[]) => updateConfig({ externalServers: next })

  const addServer = () => {
    const command = draft.command.trim()
    if (!command) {
      setFormError('Command is required (for example: uv or npx).')
      return
    }
    const name = draft.name.trim() || command
    const id = draft.id.trim() || slugify(name)
    if (!id) {
      setFormError('Could not derive an id — please enter one.')
      return
    }
    if (servers.some((s) => s.id === id)) {
      setFormError(`A server with id \"${id}\" already exists.`)
      return
    }
    setFormError(null)
    setServers([
      ...servers,
      {
        id,
        name,
        command,
        args: draft.args.split('\n').map((a) => a.trim()).filter(Boolean),
        env: parseEnv(draft.env),
        enabled: true,
      },
    ])
    setDraft(EMPTY_DRAFT)
  }

  const removeServer = (id: string) => setServers(servers.filter((s) => s.id !== id))

  /** Probe the DRAFT command without adding it. */
  const testDraft = async () => {
    const command = draft.command.trim()
    if (!command) {
      setFormError('Command is required (for example: uv or npx).')
      return
    }
    setFormError(null)
    setProbing(true)
    setProbe(null)
    try {
      const result = await api.config.testExternalMcpServer({
        command,
        args: draft.args.split('\n').map((a) => a.trim()).filter(Boolean),
        env: parseEnv(draft.env),
      })
      setProbe(result)
    } catch (err) {
      setProbe({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setProbing(false)
    }
  }

  const toggleServer = (id: string, enabled: boolean) =>
    setServers(servers.map((s) => (s.id === id ? { ...s, enabled } : s)))

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="MCP Server" right={<SaveIndicator status={status} onRetry={retry} />} />

      <SettingsScrollArea className="px-4 py-5 md:px-8">
        {config && (
          <div className="max-w-[880px] mx-auto">
            <ConfigSection
              title="HTTP Server"
              description="Expose a local Streamable HTTP endpoint to external MCP clients."
            >
              <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border/60 py-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground">Run endpoint</p>
                  <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
                    Available to local clients while OpenAlice is running.
                  </p>
                </div>
                <Toggle
                  ariaLabel="Run the MCP endpoint"
                  size="sm"
                  checked={config.enabled}
                  onChange={(enabled) => updateConfig({ enabled })}
                />
              </div>
              <Field label="Port" controlId="mcp-server-port">
                <input
                  id="mcp-server-port"
                  className={inputClass}
                  type="number"
                  disabled={!config.enabled}
                  value={config.port}
                  onChange={(e) => updateConfig({ port: Number(e.target.value) })}
                />
              </Field>
            </ConfigSection>

            <ConfigSection
              title="External servers"
              description="Connect OpenAlice to third-party MCP servers. Their tools become available to Workspace agents as mcp__<id>__<tool>. Servers start with OpenAlice and are skipped (not fatal) if they fail to connect."
            >
              {servers.length === 0 ? (
                <p className="py-2 text-[13px] text-muted-foreground">
                  No external servers configured.
                </p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {servers.map((server) => (
                    <li key={server.id} className="flex items-start justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-foreground">
                          {server.name}
                          <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                            {server.id}
                          </span>
                        </p>
                        <p className="mt-0.5 break-all font-mono text-[11px] leading-5 text-muted-foreground">
                          {[server.command, ...server.args].join(' ')}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <Toggle
                          ariaLabel={`Enable ${server.name}`}
                          size="sm"
                          checked={server.enabled}
                          onChange={(enabled) => toggleServer(server.id, enabled)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeServer(server.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 space-y-3 rounded-lg border border-border/60 p-3">
                <p className="text-[12px] font-medium text-foreground">Add a server</p>

                <Field label="Command" controlId="mcp-ext-command">
                  <input
                    id="mcp-ext-command"
                    className={inputClass}
                    placeholder="uv"
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  />
                </Field>

                <Field label="Arguments (one per line)" controlId="mcp-ext-args">
                  <textarea
                    id="mcp-ext-args"
                    className={`${inputClass} min-h-[72px] font-mono`}
                    placeholder={'run\n--directory\n/path/to/server\ntradingview-mcp'}
                    value={draft.args}
                    onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Display name" controlId="mcp-ext-name">
                    <input
                      id="mcp-ext-name"
                      className={inputClass}
                      placeholder="TradingView"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </Field>
                  <Field label="Id (optional)" controlId="mcp-ext-id">
                    <input
                      id="mcp-ext-id"
                      className={inputClass}
                      placeholder="tradingview"
                      value={draft.id}
                      onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    />
                  </Field>
                </div>

                <Field label="Environment (KEY=value per line)" controlId="mcp-ext-env">
                  <textarea
                    id="mcp-ext-env"
                    className={`${inputClass} min-h-[60px] font-mono`}
                    placeholder="TRADINGVIEW_MCP_CACHE=1"
                    value={draft.env}
                    onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                  />
                </Field>

                {formError && (
                  <p role="alert" className="text-[12px] text-destructive">{formError}</p>
                )}

                {probe && (
                  <div
                    role="status"
                    className={`rounded-md border p-2 text-[12px] leading-5 ${
                      probe.ok
                        ? 'border-emerald-500/40 bg-emerald-500/5 text-foreground'
                        : 'border-destructive/40 bg-destructive/5 text-destructive'
                    }`}
                  >
                    {probe.ok ? (
                      <>
                        <p className="font-medium">
                          Connected
                          {probe.server?.name ? ` \u00b7 ${probe.server.name}` : ''}
                          {probe.server?.version ? ` ${probe.server.version}` : ''}
                          {' \u00b7 '}
                          {probe.tools?.length ?? 0} tool{(probe.tools?.length ?? 0) === 1 ? '' : 's'}
                        </p>
                        {probe.tools && probe.tools.length > 0 && (
                          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                            {probe.tools.map((t) => t.name).join(', ')}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="break-all">{probe.error ?? 'Connection failed.'}</p>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={probing} onClick={() => void testDraft()}>
                    {probing ? 'Testing\u2026' : 'Test'}
                  </Button>
                  <Button type="button" size="sm" onClick={addServer}>
                    Add server
                  </Button>
                </div>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  Restart OpenAlice after adding or removing a server. The child process inherits HOME and PATH,
                  so `uv`, `npx`, and absolute paths all work.
                </p>
              </div>
            </ConfigSection>
          </div>
        )}
        {loadError && (
          <div role="alert" className="mx-auto max-w-[880px] text-center">
            <p className="text-[13px] text-destructive">Failed to load configuration.</p>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        )}
      </SettingsScrollArea>
    </div>
  )
}
