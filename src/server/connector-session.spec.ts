import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { registerConnectorSessionRoutes } from './connector-session.js'

function fixture(overrides: Record<string, unknown> = {}) {
  const newConnectorDeskSession = async () => ({ started: true, previousResumeId: 'resume-old' })
  const svc = { newConnectorDeskSession, ...overrides }
  const app = new Hono()
  registerConnectorSessionRoutes(app, () => svc as never)
  const post = async (id = 'telegram') => {
    const res = await app.request(`/cli/connector-new-session/${id}`, { method: 'POST' })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { post, svc }
}

describe('connector desk new-session route', () => {
  it('resets the desk owner without caller-supplied identity', async () => {
    const { post } = fixture()
    const { status, body } = await post()
    expect(status).toBe(200)
    expect(body).toEqual({ started: true, previousResumeId: 'resume-old' })
  })

  it('reports a refusal while a turn is running', async () => {
    const { post } = fixture({ newConnectorDeskSession: async () => ({ started: false }) })
    expect((await post()).body).toEqual({ started: false })
  })

  it('surfaces a missing desk as a 400', async () => {
    const { post } = fixture({ newConnectorDeskSession: async () => { throw new Error('Chat not found') } })
    const { status, body } = await post('discord')
    expect(status).toBe(400)
    expect(body.error).toBe('Chat not found')
  })

  it('fails cleanly when Alice is not ready', async () => {
    const app = new Hono()
    registerConnectorSessionRoutes(app, () => null)
    const res = await app.request('/cli/connector-new-session/telegram', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})
