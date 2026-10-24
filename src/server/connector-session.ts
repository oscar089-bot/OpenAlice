import type { Hono } from 'hono'
import { createHash } from 'node:crypto'
import {
  connectorSessionRequestSchema,
  type ConnectorSessionPanel,
  type ConnectorSessionRequest,
  type ConnectorSessionRow,
} from '@traderalice/connector-protocol'
import type { WorkspaceService } from '../workspaces/service.js'
import type { ConnectorDesk } from '../workspaces/issues/connector-desk.js'
import { issueAssigneeResumeId } from '../workspaces/issues/declaration.js'
import { sessionPresence } from '../workspaces/resume-registry.js'
import { sessionSignature } from '../workspaces/session-signature.js'
import { updateIssueFields } from '../workspaces/issues/mutate.js'
import { readCredentials, type Credential } from '../core/config.js'
import { compatibleCredentials } from '../workspaces/credential-injection.js'
import { BUILTIN_PRESETS } from '../ai-providers/presets.js'
import { createAIProvider } from '../ai-providers/provider.js'
import { providerModelCatalog } from '../ai-providers/model-catalog.js'
import { isModelReasoningEffort } from '../ai-providers/model-semantics.js'
import {
  runtimeEffortOptions,
  runtimeModelOptions,
  runtimeModelSemantics,
} from '../ai-providers/runtime-model-options.js'

/** Commit one owner action against the desk Issue's single `assignee`. */
async function applyChange(
  svc: WorkspaceService,
  desk: ConnectorDesk,
  wsDir: string,
  request: ConnectorSessionRequest,
  panel: ConnectorSessionPanel,
): Promise<ConnectorSessionPanel> {
  if (request.revision && request.revision !== panel.revision) {
    throw new Error('The desk changed. Reopen /session before saving.')
  }
  // Switch and delete re-home the live desk, so an in-flight turn must finish.
  // Preparing a future Session leaves the current owner alone, so it is safe.
  if ((request.resumeId || request.policy) && panel.running) {
    throw new Error('A reply is running. Use /stop first.')
  }

  if (request.resumeId) {
    const identity = svc.resumeRegistry.get(request.resumeId)
    if (!identity || identity.wsId !== desk.wsId) {
      throw new Error('That Session is not in this desk Workspace.')
    }
    // Delete shares the web path exactly: soft-delete the product identity AND
    // physically purge its comments/provenance, re-point its watchers, and
    // refuse while a turn runs. Diverging here would make one surface lie about
    // what "deleted" means.
    if (request.delete) {
      if (identity.lifecycle === 'retired' || sessionPresence(identity) === 'deleted') {
        throw new Error('That Session is already gone.')
      }
      await svc.deleteSessionPresence({ wsId: desk.wsId, resumeId: request.resumeId })
      // The desk must not keep pointing at the Session it just removed.
      if (panel.currentResumeId === request.resumeId) {
        await updateIssueFields(wsDir, desk.issue.id, {
          assignee: '@new-then-resume',
          agent: null,
          credential: null,
          credentialSource: null,
          model: null,
          effort: null,
        })
      }
      return { ...panel, saved: true }
    }
    if (identity.lifecycle === 'retired' || sessionPresence(identity) === 'deleted') {
      throw new Error('That Session can no longer be used.')
    }
    const updated = await updateIssueFields(wsDir, desk.issue.id, {
      assignee: sessionSignature(request.resumeId),
      // A bound Session owns its runtime, so stale overrides must not shadow it.
      agent: null,
      credential: null,
      credentialSource: null,
      model: null,
      effort: null,
    })
    if (!updated.ok) {
      throw new Error(updated.reason === 'invalid' ? updated.error : 'Could not switch Session')
    }
    return { ...panel, saved: true, currentResumeId: request.resumeId, assignee: sessionSignature(request.resumeId) }
  }

  if (request.policy) {
    const assignee = request.policy === 'new-then-resume' ? '@new-then-resume' : '@new-each-run'
    const updated = await updateIssueFields(wsDir, desk.issue.id, { assignee })
    if (!updated.ok) {
      throw new Error(updated.reason === 'invalid' ? updated.error : 'Could not change assignment policy')
    }
    return { ...panel, saved: true, currentResumeId: null, assignee }
  }

  const draft = panel.draft
  if (!draft?.agent) throw new Error('Choose a runtime first.')
  // Create reuses the already-tested recruitment path: persist the runtime on
  // the Issue and let the next message claim a fresh Session. There is no
  // second Session-creation mechanism to keep in sync with the scheduler.
  // `new-then-resume` makes that claim adopt this exact runtime and then become
  // the permanent owner; `new-each-run` keeps recruiting per fire.
  const assignee = draft.policy === 'new-each-run' ? '@new-each-run' : '@new-then-resume'
  const updated = await updateIssueFields(wsDir, desk.issue.id, {
    assignee,
    agent: draft.agent,
    ...(draft.credential === 'native'
      ? { credentialSource: 'native' as const, credential: null }
      : draft.credential
        ? { credential: draft.credential.slice(6), credentialSource: null }
        : { credential: null, credentialSource: null }),
    model: draft.model,
    effort: isModelReasoningEffort(draft.effort) ? draft.effort : null,
  })
  if (!updated.ok) {
    throw new Error(updated.reason === 'invalid' ? updated.error : 'Could not prepare a new Session')
  }
  return { ...panel, saved: true, currentResumeId: null, assignee }
}
const revisionOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')

/**
 * Model ids a credential actually serves.
 *
 * `runtimeModelOptions` answers a different question: which ids a *static
 * preset* advertises. That is right for the vendor presets, but a custom
 * endpoint (`vendor: 'custom'`) has no bundled catalog by design — it is
 * free-form — so the static answer is always an empty list. The owner's real
 * models live only behind the endpoint, which is exactly what the provider's
 * cached discovery snapshot holds.
 *
 * Read the snapshot first and fall back to the static preset list. Discovery
 * never blocks this path: `read` serves whatever is cached and refreshes in the
 * background, so an unreachable endpoint degrades to "type it manually" rather
 * than hanging the panel.
 */
export async function discoveredModels(
  credential: Credential | null,
  fallback: readonly { id: string; label: string }[],
  read: (provider: ReturnType<typeof createAIProvider>) => Promise<{ models: readonly { id: string; label: string }[] }> = (provider) => providerModelCatalog.read(provider),
): Promise<{ id: string; label: string }[]> {
  if (!credential) return fallback.map((model) => ({ id: model.id, label: model.label }))
  try {
    const catalog = await read(createAIProvider('session-draft', credential))
    const known = new Map(fallback.map((model) => [model.id, model.label]))
    const merged = catalog.models.map((model) => ({
      id: model.id,
      label: known.get(model.id) ?? model.label ?? model.id,
    }))
    // A discovered endpoint is authoritative; a bundled list is not a substitute
    // for it. Only keep the static entries when discovery produced nothing.
    return merged.length > 0 ? merged : fallback.map((model) => ({ id: model.id, label: model.label }))
  } catch {
    return fallback.map((model) => ({ id: model.id, label: model.label }))
  }
}

/** Rows per roster page, matching the chat-panel density. */
const PAGE_SIZE = 6

/** Read the desk roster + the runtime draft for one panel render. */
async function buildPanel(
  svc: WorkspaceService,
  desk: ConnectorDesk,
  request: ConnectorSessionRequest,
): Promise<ConnectorSessionPanel> {
  const currentResumeId = issueAssigneeResumeId(desk.issue.assignee)
  // A deleted Session is gone from the product, so it must not reappear in the
  // picker. Its native transcript is retained, but offering it here would let
  // the owner select something the desk can no longer route to.
  const identities = svc.resumeRegistry
    .list({ wsId: desk.wsId })
    .filter((identity) => sessionPresence(identity) !== 'deleted')
  const running = svc.headlessTasks.list({ status: 'running' }).some((task) =>
    task.trigger?.kind === 'issue'
    && task.trigger.workspaceId === desk.wsId
    && task.trigger.issueId === desk.issue.id,
  )
  const view = request.view ?? 'sessions'
  const pageCount = Math.max(1, Math.ceil(identities.length / PAGE_SIZE))
  const page = Math.min(request.page ?? 0, pageCount - 1)
  const revision = revisionOf({
    assignee: desk.issue.assignee,
    ids: identities.map((identity) => [
      identity.resumeId,
      identity.updatedAt,
      sessionPresence(identity),
    ]),
  })

  const agents = svc.adapters.list()
    .filter((adapter) => Boolean(adapter.capabilities.headless))
    .map((adapter) => ({ id: adapter.id, label: adapter.displayName, installed: true }))
  const draftAgent = request.draft?.agent ?? desk.issue.agent ?? agents[0]?.id ?? null
  const draftAdapter = draftAgent ? svc.adapters.get(draftAgent) : undefined
  const aiProvider = draftAdapter?.capabilities.aiProvider
  const vault = aiProvider ? await readCredentials() : {}
  const credentials = aiProvider && draftAdapter
    ? [
        ...(aiProvider.credentialSource === 'runtime-or-workspace'
          ? [{ id: 'native', label: 'Runtime login' }]
          : []),
        ...compatibleCredentials(vault, draftAdapter).map(([slug, cred]) => ({
          id: `vault:${slug}`,
          label: cred.label || slug,
        })),
      ]
    : []
  const draftCredential = request.draft?.credential
    ?? (desk.issue.credential
      ? `vault:${desk.issue.credential}`
      : desk.issue.credentialSource ?? credentials[0]?.id ?? null)
  const draftCredentialValue = draftCredential && draftCredential !== 'native'
    ? vault[draftCredential.slice(6)] ?? null
    : null
  const presetCatalog = draftAdapter
    ? runtimeModelOptions({
        agent: draftAdapter.id,
        credential: draftCredentialValue,
        defaultModel: desk.issue.model ?? null,
        presets: BUILTIN_PRESETS,
      })
    : []
  // The static preset list is only half the answer. A custom/self-hosted
  // endpoint declares no bundled models, so the owner's real ids must come from
  // the credential's own discovery snapshot — the same one the web UI's model
  // picker reads. Without this, step 4 of create offered nothing but "Skip".
  const catalog = draftAdapter
    ? await discoveredModels(draftCredentialValue, presetCatalog)
    : []
  const draftModel = request.draft?.model ?? desk.issue.model ?? null
  // Semantics describe provider facts, so they come from the preset entry, not
  // from a bare discovered id. A custom model is simply unknown — `null` keeps
  // the runtime's own effort menu instead of fabricating a scale.
  const semantics = runtimeModelSemantics(draftModel, presetCatalog)
  const efforts = draftAdapter
    ? [...runtimeEffortOptions({
        agent: draftAdapter.id,
        semantics,
        modelKnown: semantics !== null,
        model: draftModel,
        // A create flow must always offer something. The Model picker keeps the
        // stricter behavior because it edits a live Session mid-conversation.
        fallbackToRuntimeTiers: true,
      })]
    : []

  return {
    issueId: desk.issue.id,
    currentResumeId,
    assignee: desk.issue.assignee,
    revision,
    running,
    view,
    page,
    pageCount,
    sessions: identities
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .map((identity): ConnectorSessionRow => ({
        resumeId: identity.resumeId,
        label: identity.displayName || identity.resumeId,
        agent: identity.agent,
        current: identity.resumeId === currentResumeId,
        running: svc.headlessTasks.latestForResumeId(identity.resumeId)?.status === 'running',
        presence: sessionPresence(identity),
        updatedAt: identity.updatedAt,
      })),
    agents,
    credentials,
    models: catalog.map((model) => ({ id: model.id, label: model.label })),
    efforts,
    draft: {
      policy: request.draft?.policy ?? null,
      agent: draftAgent,
      credential: draftCredential,
      model: draftModel,
      effort: request.draft?.effort ?? desk.issue.effort ?? null,
    },
  }
}

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

  app.post('/cli/connector-sessions/:connectorId', async (c) => {
    try {
      const request = connectorSessionRequestSchema.parse(await c.req.json())
      const svc = service()
      if (!svc) throw new Error('Alice is not ready')
      const desk = await svc.connectorDesk(c.req.param('connectorId'))
      if (!desk) throw new Error('No phone desk is bound to this chat yet.')
      const workspace = svc.registry.get(desk.wsId)
      if (!workspace) throw new Error('This desk Workspace is unavailable.')

      const panel = await buildPanel(svc, desk, request)
      if (!request.apply) return c.json(panel)
      return c.json(await applyChange(svc, desk, workspace.dir, request, panel))
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Unable to update Session settings' },
        400,
      )
    }
  })
}
