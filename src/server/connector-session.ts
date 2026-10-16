import type { Hono } from 'hono'
import type { WorkspaceService } from '../workspaces/service.js'

/**
 * Owner-facing "start a new Session" control for a connector phone desk.
 *
 * The phone desk keeps ONE durable Session for the lifetime of the chat. This
 * lets the owner deliberately start over — the next inbound message recruits a
 * fresh Session — without deleting anything: the previous Session stays active
 * and reachable by its resumeId.
 *
 * Identity comes from the URL's connector id, never from a caller-supplied
 * Workspace, Issue, or resumeId — exactly like the stop and model control
 * routes. A run in flight is never re-homed; the desk admits one turn at a
 * time, so refusing is unambiguous.
 */
export function registerConnectorSessionRoutes(app: Hono, service: () => WorkspaceService | null) {
  app.post('/cli/connector-new-session/:connectorId', async (c) => {
    try {
      const svc = service()
      if (!svc) throw new Error('Alice is not ready')
      return c.json(await svc.newConnectorDeskSession(c.req.param('connectorId')))
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Unable to start a new Session' },
        400,
      )
    }
  })
}
