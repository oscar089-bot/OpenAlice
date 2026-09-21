import type { Hono } from 'hono'
import type { WorkspaceService } from '../workspaces/service.js'

/**
 * Owner-facing stop control for a connector phone desk.
 *
 * The desk chat is the one external surface where a human can interrupt the
 * Agent turn they just started (a wrong message, a change of mind). Identity
 * comes from the URL's connector id, never from a caller-supplied Workspace or
 * task id — exactly like the model control route. The desk already admits one
 * run at a time, so there is no ambiguity about which turn stops.
 */
export function registerConnectorStopRoutes(app: Hono, service: () => WorkspaceService | null) {
  app.post('/cli/connector-stop/:connectorId', async (c) => {
    try {
      const svc = service()
      if (!svc) throw new Error('Alice is not ready')
      return c.json(await svc.stopConnectorDeskRun(c.req.param('connectorId')))
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Unable to stop the Agent reply' },
        400,
      )
    }
  })
}
