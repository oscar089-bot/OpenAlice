import { z } from 'zod'

/**
 * Owner-facing Session control for a connector phone desk.
 *
 * The desk owns exactly one Issue, and that Issue's `assignee` is the single
 * authority for which Session answers the next message. Every action here is
 * therefore a rewrite of one field — there is no second owner to keep in sync.
 *
 * Connector identity still comes from the URL path, never from this body: a
 * caller cannot point these actions at another desk.
 */
export const connectorDeskPolicySchema = z.enum(['new-each-run', 'new-then-resume'])
export type ConnectorDeskPolicy = z.infer<typeof connectorDeskPolicySchema>

/** One page of the desk roster, plus the draft for a step-by-step create. */
export const connectorSessionRequestSchema = z.object({
  /** Which panel the owner is looking at. */
  view: z.enum(['sessions', 'create']).optional(),
  /** Page index for the roster. */
  page: z.number().int().min(0).max(1000).optional(),
  /** Draft selections while composing a new Session. */
  draft: z.object({
    /** Assignment policy, chosen first in the create flow. */
    policy: connectorDeskPolicySchema.nullable().optional(),
    agent: z.string().min(1).max(80).nullable().optional(),
    credential: z.string().min(1).max(200).nullable().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    effort: z.string().min(1).max(30).nullable().optional(),
  }).strict().optional(),
  /** Stale-panel guard, mirroring `/model`. */
  revision: z.string().max(100).optional(),
  resumeId: z.string().max(200).optional(),
  policy: connectorDeskPolicySchema.optional(),
  /** Commit the draft as a new interactive Session. */
  apply: z.boolean().optional(),
  /** Delete the Session named by `resumeId` (physical purge, same as web). */
  delete: z.boolean().optional(),
}).strict()
export type ConnectorSessionRequest = z.infer<typeof connectorSessionRequestSchema>

/**
 * A roster row. `presence` is included because delete is soft on the product
 * identity (the native transcript is retained), and the owner must be able to
 * see which row is already gone rather than guess.
 */
export interface ConnectorSessionRow {
  resumeId: string
  label: string
  agent: string
  /** True while this Session is the desk's current owner. */
  current: boolean
  /** True while a turn for this Session is in flight. */
  running: boolean
  presence: 'active' | 'archived' | 'deleted'
  updatedAt: number
}

/** The runtime choice shown while composing a new Session. */
export interface ConnectorSessionAgentOption {
  id: string
  label: string
  installed: boolean
}

/**
 * Everything the connector needs to render one panel. Alice owns options,
 * validation, and persistence; the adapter owns only transient button state.
 */
export interface ConnectorSessionPanel {
  /** The desk Issue these actions mutate. */
  issueId: string
  /** Current owner, or null when the desk uses a policy assignee. */
  currentResumeId: string | null
  /** Raw assignee, so a policy (`@new-then-resume`) is visible verbatim. */
  assignee: string
  /** Hash of the roster + assignee; a stale panel must not commit. */
  revision: string
  /** True while any desk turn is in flight; blocking actions say why. */
  running: boolean
  view: 'sessions' | 'create'
  page: number
  pageCount: number
  sessions: ConnectorSessionRow[]
  /** Runtimes available for a new Session. */
  agents: ConnectorSessionAgentOption[]
  /** Credential/model/effort choices for the drafted runtime. */
  credentials: Array<{ id: string; label: string }>
  models: Array<{ id: string; label: string }>
  efforts: string[]
  draft?: {
    /** Assignment policy chosen at the start of the create flow. */
    policy: ConnectorDeskPolicy | null
    agent: string | null
    credential: string | null
    model: string | null
    effort: string | null
  }
  /** Present once a create/switch/delete committed. */
  saved?: boolean
}
