import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { registerConnectorStopRoutes } from './connector-stop.js'

function fixture(overrides: Record<string, unknown> = {}) {
  const stopConnectorDeskRun = async () => ({ stopped: true, taskId: 'run-1' })
  const svc = { stopConnectorDeskRun, ...overrides }
  const app = new Hono()
  registerConnectorStopRoutes(app, () => svc as never)
  const post = async (id = 'telegram') => {
    const res = await app.request(`/cli/connector-stop/${id}`, { method: 'POST' })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { post, svc }
}

describe('connector desk stop route', () => {
  it('stops the connector-owned desk run without caller-supplied identity', async () => {
    const { post } = fixture()
    const { status, body } = await post()
    expect(status).toBe(200)
    expect(body).toEqual({ stopped: true, taskId: 'run-1' })
  })

  it('reports when nothing is running', async () => {
    const { post } = fixture({ stopConnectorDeskRun: async () => ({ stopped: false }) })
    expect((await post()).body).toEqual({ stopped: false })
  })

  it('surfaces a missing desk as a 400', async () => {
    const { post } = fixture({ stopConnectorDeskRun: async () => { throw new Error('Chat not found') } })
    const { status, body } = await post('discord')
    expect(status).toBe(400)
    expect(body.error).toBe('Chat not found')
  })

  it('fails cleanly when Alice is not ready', async () => {
    const app = new Hono()
    registerConnectorStopRoutes(app, () => null)
    const res = await app.request('/cli/connector-stop/telegram', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})
