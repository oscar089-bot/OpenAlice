import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Plugin, EngineContext } from '../core/types.js'
import type { ToolCenter } from '../core/tool-center.js'
import {
  type WorkspaceToolCenter,
  makeInboxEntryOriginResolver,
  makeWorkspaceResolver,
} from '../core/workspace-tool-center.js'
import type { IInboxStore } from '../core/inbox-store.js'
import type { IEntityStore } from '../core/entity-store.js'
import type { IMemoryStore } from '../core/memory-store.js'
import type { WorkspaceService } from '../workspaces/service.js'
import type { InboxOrigin } from '../core/inbox-store.js'
import { extractMcpShape, wrapToolExecute } from '../core/mcp-export.js'
import { registerCliRoutes } from './cli.js'
import { resolveInboxOrigin } from './inbox-origin.js'
import { createWorkspaceConversationControl } from '../workspaces/conversation-control.js'
import { sessionCoworkerLabel } from '../workspaces/session-registry.js'

/**
 * MCP Plugin — exposes OpenAlice tools via Streamable HTTP, plus the CLI gateway.
 *
 *   GET/POST /mcp           Workspace-independent surface (ToolCenter).
 *                           Trading / market / news / brain / etc. — what
 *                           OpenAlice provides to any MCP client. No
 *                           identity required.
 *
 *   GET/POST /mcp/:wsId     Workspace-scoped surface (WorkspaceToolCenter).
 *                           inbox_push / inbox_read + workspace_path +
 *                           entity_upsert / entity_search; tools
 *                           that need workspaceId close over it via the factory
 *                           pattern. The URL path IS the identity carrier —
 *                           agent never sees or supplies workspaceId, and
 *                           bootstrap.sh bakes the per-workspace URL into
 *                           the workspace's own .mcp.json.
 *
 *   GET  /cli/:wsId/:export/manifest   Same identity-by-URL trick — the gateway
 *   POST /cli/:wsId/:export/invoke     for the workspace-local CLIs (alice*, traderhub)
 *                              (`:export` = data | workspace; see ./cli.ts).
 *                              Reuses this server's port so the shim needs no
 *                              token.
 *
 * SECURITY POSTURE: this whole listener is UNAUTHENTICATED and binds
 * 127.0.0.1 only (see the serve() call). The tool surface includes trading;
 * its protection is the loopback boundary — every consumer (agent CLIs, the
 * `alice*` shims) is a local workspace subprocess. There is no auth layer
 * because there is intentionally no remote caller; the wsId in the path is
 * routing, not a secret. Remote/multi-user access belongs to the web port,
 * which gates on the admin token. Do NOT make this honor OPENALICE_BIND_HOST.
 *
 * Holds references to both registries and the WorkspaceService (for wsId
 * registry lookup). Tools are rebuilt per-request so disable/enable +
 * factory closure over wsId both work without restart.
 */
export class McpPlugin implements Plugin {
  name = 'mcp'
  private server: ReturnType<typeof serve> | null = null

  constructor(
    private toolCenter: ToolCenter,
    private port: number,
    private workspaceToolCenter: WorkspaceToolCenter,
    private inboxStore: IInboxStore,
    private entityStore: IEntityStore,
    /** Durable user-global agent memory, injected into workspace tool builds. */
    private memoryStore: IMemoryStore | undefined,
    /** Lazy because WorkspaceService is created later (deferred during web
     *  plugin start); McpPlugin starts earlier. Resolved at request time. */
    private getWorkspaceService: () => WorkspaceService | null,
  ) {}

  async start(_ctx: EngineContext) {
    const toolCenter = this.toolCenter
    const workspaceToolCenter = this.workspaceToolCenter
    const inboxStore = this.inboxStore
    const entityStore = this.entityStore
    const memoryStore = this.memoryStore
    const getWorkspaceService = this.getWorkspaceService

    /** Build a per-request McpServer with the global ToolCenter catalog. */
    const createGlobalMcpServer = async () => {
      const tools = await toolCenter.getMcpTools()
      const mcp = new McpServer({ name: 'open-alice', version: '1.0.0' })
      for (const [name, t] of Object.entries(tools)) {
        if (!t.execute) continue
        mcp.registerTool(name, {
          description: t.description,
          inputSchema: extractMcpShape(t),
        }, wrapToolExecute(t))
      }
      return mcp
    }

    /** Build a per-request McpServer scoped to a specific workspace.
     *  Each WorkspaceToolFactory is invoked with the URL's wsId so its
     *  tools' execute() closes over that identity. */
    const createWorkspaceMcpServer = (wsId: string, wsLabel: string, origin?: InboxOrigin) => {
      // GLOBAL issue-board reader, backed by the live WorkspaceService — parity
      // with the CLI gateway so issue_list / issue_show read EVERY workspace's
      // issues here too. Absent when the service isn't up → tools self-read.
      const svc = getWorkspaceService()
      const tools = workspaceToolCenter.build({
        workspaceId: wsId,
        workspaceLabel: wsLabel,
        inboxStore,
        entityStore,
        ...(memoryStore ? { memoryStore } : {}),
        ...(svc ? { provenanceStore: svc.provenanceStore } : {}),
        ...(svc ? { conversation: createWorkspaceConversationControl(svc) } : {}),
        ...(svc ? { templateUpgrades: svc.templateUpgrades } : {}),
        ...(svc ? {
          setSessionDisplayName: async (input) => {
            const identity = await svc.setSessionDisplayName({
              wsId,
              resumeId: input.resumeId,
              displayName: input.displayName,
            })
            return {
              resumeId: identity.resumeId,
              ...(identity.displayName ? { displayName: identity.displayName } : {}),
            }
          },
        } : {}),
        // Parity with the CLI gateway so external MCP consumers get the same
        // workspace_path resolution — shared helper, so the two can't drift.
        resolveWorkspace: makeWorkspaceResolver(getWorkspaceService),
        ...(svc ? {
          workspaceInventory: async () => Promise.all(svc.registry.list().map(async (meta) => {
            await svc.sessionRegistry.ensureLoaded(meta.id)
            void svc.refreshSessionTitles?.(meta)
            const sessions = svc.sessionRegistry.listFor(meta.id)
            const activity = svc.workspaceRuntimeActivity(meta.id)
            return {
              id: meta.id,
              tag: meta.tag,
              ...(meta.template ? { template: meta.template } : {}),
              createdAt: meta.createdAt,
              sessions: {
                total: sessions.length,
                running: activity.sessions.length,
                recent: sessions
                  .slice()
                  .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
                  .slice(0, 4)
                  .map((session) => ({
                    resumeId: session.resumeId,
                    agent: session.agent,
                    title: sessionCoworkerLabel(
                      session,
                      svc.resumeRegistry.get(session.resumeId)?.displayName,
                    ) ?? session.name,
                    state: session.state,
                    lastActiveAt: session.lastActiveAt,
                  })),
              },
              headlessRunning: activity.headless.length,
            }
          })),
        } : {}),
        resolveInboxOrigin: makeInboxEntryOriginResolver(getWorkspaceService),
        ...(svc ? { sessionDirectory: (id: string, limit?: number) => svc.sessionDirectory(id, limit) } : {}),
        ...(svc ? {
          resolveSessionIdentity: (resumeId: string) => {
            const identity = svc.resumeRegistry.get(resumeId)
            return identity
              ? {
                  workspaceId: identity.wsId,
                  agent: identity.agent,
                  resumable: identity.lifecycle !== 'retired' && Boolean(identity.agentSessionId),
                }
              : null
          },
        } : {}),
        ...(svc
          ? {
              issueRuns: { start: (w: string, i: string, r?: string) => svc.startIssueRun(w, i, r) },
              board: {
                snapshot: () => svc.issuesSnapshot(),
                detail: (w: string, i: string) => svc.issueDetail(w, i),
                resolveByName: (n: string) => svc.resolveIssuesByName(n),
              },
            }
          : {}),
        // Agent-invisible run provenance from the out-of-band header (resolved
        // server-side from the authoritative registry). Absent → undefined.
        ...(origin ? { origin } : {}),
        ...(origin?.kind === 'headless' && origin.runId && svc ? { callerRun: svc.headlessTasks.get(origin.runId) ?? undefined } : {}),
      })
      const mcp = new McpServer({ name: 'open-alice-workspace', version: '1.0.0' })
      for (const [name, t] of Object.entries(tools)) {
        if (!t.execute) continue
        mcp.registerTool(name, {
          description: t.description,
          inputSchema: extractMcpShape(t),
        }, wrapToolExecute(t))
      }
      return mcp
    }

    const app = new Hono()

    app.use('*', cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version', 'x-openalice-run', 'x-openalice-session'],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    }))

    app.all('/mcp', async (c) => {
      const transport = new WebStandardStreamableHTTPServerTransport()
      const mcp = await createGlobalMcpServer()
      await mcp.connect(transport)
      return transport.handleRequest(c.req.raw)
    })

    app.all('/mcp/:wsId', async (c) => {
      const wsId = c.req.param('wsId')
      const svc = getWorkspaceService()
      if (!svc) {
        // Workspace subsystem hasn't started yet — reject loudly rather
        // than serving an empty catalog.
        return c.text('workspace service unavailable', 503)
      }
      const meta = svc.registry.get(wsId)
      if (!meta) return c.text('unknown workspace', 404)

      // Out-of-band identity (agent never sees it): the spawn-injected AQ_RUN_ID
      // (headless) / AQ_SESSION_ID (interactive) rides these mutually-exclusive
      // headers, resolved server-side to an authoritative origin and baked into
      // the tools. The session header is validated against THIS workspace's
      // session registry.
      const origin = resolveInboxOrigin(
        {
          run: c.req.header('x-openalice-run'),
          session: c.req.header('x-openalice-session'),
          wsId: meta.id,
        },
        getWorkspaceService,
      )

      const transport = new WebStandardStreamableHTTPServerTransport()
      const mcp = createWorkspaceMcpServer(meta.id, meta.tag, origin)
      await mcp.connect(transport)
      return transport.handleRequest(c.req.raw)
    })

    // CLI gateway — same app, same open port, same identity-by-URL trick.
    registerCliRoutes(app, {
      toolCenter,
      workspaceToolCenter,
      inboxStore,
      entityStore,
      ...(memoryStore ? { memoryStore } : {}),
      getWorkspaceService,
    })

    // Internal tool/CLI listener. It is UNAUTHENTICATED and carries the full
    // tool catalog (trading included), so its default protection is the
    // loopback boundary: only local workspace subprocesses (native agent CLIs
    // and the CLI shims) dial it. That default is unchanged.
    //
    // OPENALICE_INTERNAL_BIND_HOST deliberately controls this listener, and
    // is a SEPARATE knob from OPENALICE_BIND_HOST: widening the authenticated
    // web port (47331) must never silently widen this one. Set it only when a
    // firewall or private network already fronts the host — never expose it
    // directly to the public internet.
    //
    // In Docker, the default keeps MCP on container-local loopback; only 47331
    // is published, so nothing external reaches it regardless.
    const internalBindHost = (process.env['OPENALICE_INTERNAL_BIND_HOST'] ?? '127.0.0.1').trim()
    this.server = serve({ fetch: app.fetch, port: this.port, hostname: internalBindHost }, (info) => {
      console.log(`mcp plugin listening on http://${internalBindHost}:${info.port}/mcp (+ /mcp/:wsId, /cli)`)
    })
  }

  async stop() {
    this.server?.close()
  }
}
