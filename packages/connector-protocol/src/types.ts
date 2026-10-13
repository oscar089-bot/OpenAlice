import { z } from 'zod'

export const connectorFieldKindSchema = z.enum(['text', 'secret', 'number', 'boolean'])
export type ConnectorFieldKind = z.infer<typeof connectorFieldKindSchema>

export const connectorFieldOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
})
export type ConnectorFieldOption = z.infer<typeof connectorFieldOptionSchema>

export const connectorFieldDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  kind: connectorFieldKindSchema,
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
  /** Slash command that owns this value. Settings renders these fields as
   *  lifecycle output rather than ordinary operator-entered configuration. */
  learnedBy: z.string().min(1).optional(),
  /** Settings card section. `preferences` stays out of connection details. */
  group: z.enum(['credentials', 'preferences']).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Finite values rendered as an explicit choice instead of free-form input. */
  options: z.array(connectorFieldOptionSchema).min(2).max(6).optional(),
})
export type ConnectorFieldDefinition = z.infer<typeof connectorFieldDefinitionSchema>

/** Capabilities a connector may advertise. Each adapter implements its own
 *  interaction; the catalog only says the command exists.
 *  `desk` means this adapter owns one phone-desk Issue and owner-chat ingest. */
export const connectorCapabilitySchema = z.enum(['inbox', 'settings', 'uta', 'desk'])
export type ConnectorCapability = z.infer<typeof connectorCapabilitySchema>

export const connectorSetupLinkSchema = z.object({
  key: z.string().min(1),
  url: z.string().url(),
})
export type ConnectorSetupLink = z.infer<typeof connectorSetupLinkSchema>

export const connectorDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  fields: z.array(connectorFieldDefinitionSchema),
  commands: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
  })).default([]),
  capabilities: z.array(connectorCapabilitySchema).optional(),
  /** Official third-party entry points used by the generic credential guide. */
  setupLinks: z.array(connectorSetupLinkSchema).max(3).optional(),
})
export type ConnectorDefinition = z.infer<typeof connectorDefinitionSchema>

export const connectorAdapterConfigSchema = z.object({
  enabled: z.boolean().default(false),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
})
export type ConnectorAdapterConfig = z.infer<typeof connectorAdapterConfigSchema>

export const connectorConfigSchema = z.object({
  version: z.literal(1).default(1),
  adapters: z.record(z.string(), connectorAdapterConfigSchema).default({}),
})
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>

export const publicConnectorAdapterConfigSchema = z.object({
  enabled: z.boolean(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  configuredSecrets: z.array(z.string()),
})
export type PublicConnectorAdapterConfig = z.infer<typeof publicConnectorAdapterConfigSchema>

export const publicConnectorConfigSchema = z.object({
  serviceEnabled: z.boolean(),
  adapters: z.record(z.string(), publicConnectorAdapterConfigSchema),
})
export type PublicConnectorConfig = z.infer<typeof publicConnectorConfigSchema>

const connectorSettingValueSchema = z.union([z.string(), z.number(), z.boolean()])

/** Adapter-scoped configuration command. Public callers never send a complete
 * Connector document or secret-presence markers: each mutation owns only the
 * named adapter and the explicit fields in this payload. */
export const connectorAdapterMutationSchema = z.object({
  enabled: z.boolean().optional(),
  set: z.record(z.string(), connectorSettingValueSchema).default({}),
  unset: z.array(z.string().min(1)).max(32).default([]),
  setSecrets: z.record(z.string(), z.string()).default({}),
  removeSecrets: z.array(z.string().min(1)).max(16).default([]),
}).superRefine((value, context) => {
  if (
    value.enabled === undefined
    && Object.keys(value.set).length === 0
    && value.unset.length === 0
    && Object.keys(value.setSecrets).length === 0
    && value.removeSecrets.length === 0
  ) {
    context.addIssue({ code: 'custom', message: 'Connector adapter mutation is empty.' })
  }
})
export type ConnectorAdapterMutation = z.infer<typeof connectorAdapterMutationSchema>

export const connectorServiceMutationSchema = z.object({ enabled: z.boolean() })
export type ConnectorServiceMutation = z.infer<typeof connectorServiceMutationSchema>

export const publicConnectorAdapterMutationResultSchema = z.object({
  serviceEnabled: z.boolean(),
  serviceChanged: z.boolean(),
  adapterChanged: z.boolean(),
  adapter: publicConnectorAdapterConfigSchema,
})
export type PublicConnectorAdapterMutationResult = z.infer<typeof publicConnectorAdapterMutationResultSchema>

/** Keep inline delivery bounded below both Discord's ordinary upload limit and
 * Telegram's document limit. Alice reads only the small Markdown reports that
 * Inbox already exposes; Connector Service never reaches back into a Workspace. */
export const MAX_CONNECTOR_ATTACHMENT_BYTES = 1024 * 1024
export const MAX_CONNECTOR_ATTACHMENTS = 5

export const connectorAttachmentSourceSchema = z.object({
  sizeBytes: z.number().int().min(0).max(MAX_CONNECTOR_ATTACHMENT_BYTES),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  detectedEncoding: z.string().min(1).max(64).optional(),
  detectionConfidence: z.number().min(0).max(100).optional(),
})

export const connectorAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(128),
  sizeBytes: z.number().int().min(0).max(MAX_CONNECTOR_ATTACHMENT_BYTES),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Source evidence remains distinct when Alice creates an encoding-normalized
  // delivery copy. The Workspace file itself is never rewritten.
  source: connectorAttachmentSourceSchema.optional(),
  // One MiB is at most 1,398,104 base64 characters. The small allowance keeps
  // schema evolution from rejecting equivalent padded encodings.
  contentBase64: z.string().max(1_400_000),
})
export type ConnectorAttachment = z.infer<typeof connectorAttachmentSchema>

export const inboxNotificationSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  workspaceId: z.string().min(1),
  workspaceLabel: z.string().optional(),
  title: z.string().min(1),
  body: z.string().default(''),
  attachments: z.array(connectorAttachmentSchema).max(MAX_CONNECTOR_ATTACHMENTS).optional(),
  /** Adapter allow-list. Absent preserves the fan-out to every push-enabled
   *  adapter; present restricts delivery to those ids. */
  deliverTo: z.array(z.string().min(1)).max(8).optional(),
  href: z.string().optional(),
  provenance: z.object({
    resumeId: z.string().optional(),
    actorLabel: z.string().optional(),
  }).optional(),
})
export type InboxNotification = z.infer<typeof inboxNotificationSchema>

export const connectorAdapterHealthSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  status: z.enum(['disabled', 'starting', 'awaiting_link', 'healthy', 'degraded', 'stopped']),
  detail: z.string().optional(),
  owner: z.string().optional(),
  lastAttemptAt: z.string().datetime().optional(),
  lastSuccessAt: z.string().datetime().optional(),
  nextAttemptAt: z.string().datetime().optional(),
  consecutiveFailures: z.number().int().min(0).optional(),
  lastError: z.string().optional(),
})
export type ConnectorAdapterHealth = z.infer<typeof connectorAdapterHealthSchema>

export const connectorServiceHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded']),
  startedAt: z.string().datetime(),
  adapters: z.array(connectorAdapterHealthSchema),
})
export type ConnectorServiceHealth = z.infer<typeof connectorServiceHealthSchema>

export const connectorDeliveryReceiptSchema = z.object({
  accepted: z.literal(true),
  deliveryId: z.string().min(1),
})

/** Telegram `sendMessage` cap. Used when rich-message send falls back to plain text. */
export const TELEGRAM_PLAIN_TEXT_MAX = 4096

/** Owner-private chat text. Not an Inbox item. Telegram `sendRichMessage` allows 32768 UTF-8 characters. */
export const OWNER_CHAT_TEXT_MAX = 32_768

export const ownerChatPhaseSchema = z.enum(['accepted', 'progress', 'final', 'failed'])
export type OwnerChatPhase = z.infer<typeof ownerChatPhaseSchema>

/**
 * One tool the turn has touched, with the outcome the runner reported.
 *
 * `name` is the raw vendor name (`Read`, `Bash`, `mcp__srv__tool`); rendering
 * shortens it. Status is carried per-tool rather than only as an aggregate
 * count, because "3 tools, 1 failed" does not say WHICH one failed.
 */
export const ownerChatToolStatusSchema = z.enum(['running', 'completed', 'failed'])
export type OwnerChatToolStatus = z.infer<typeof ownerChatToolStatusSchema>

export const ownerChatToolSchema = z.object({
  name: z.string().min(1).max(120),
  status: ownerChatToolStatusSchema,
  /** Wall-clock duration in ms. Present once the tool finished. */
  durationMs: z.number().int().min(0).optional(),
  /**
   * Short single-line reason for a failure.
   *
   * This is the ONE place tool output crosses the wire, and it is deliberate: a
   * failure with no reason is not actionable, and "1 failed" alone cannot say
   * which tool or why. Clipped to one line upstream so a path-heavy stack trace
   * cannot arrive here, and only ever set for `failed`.
   */
  error: z.string().min(1).max(200).optional(),
})
export type OwnerChatTool = z.infer<typeof ownerChatToolSchema>

/**
 * Compact live activity for the transport's ephemeral slot.
 *
 * Deliberately STRUCTURED rather than pre-rendered markdown: Alice's progress
 * publisher is debounced at 1s, so a transport that only re-displayed Alice's
 * last string would freeze during a long tool call. A transport that owns the
 * render can advance its own animation locally between updates, and a chat
 * surface without layout primitives (Telegram) renders the same data its own
 * way.
 *
 * No tool input/output: those are noisy and can carry paths. Only the tool NAME
 * is projected, which is what makes an otherwise-silent turn legible.
 */
export const ownerChatActivitySchema = z.object({
  /** Tool calls seen this turn, in flight or finished. */
  toolCalls: z.number().int().min(0),
  /** Subset of `toolCalls` that ended in failure. */
  toolFailures: z.number().int().min(0),
  /** Name of the tool running right now, when one is. */
  currentTool: z.string().min(1).max(120).optional(),
  /**
   * The turn's LATEST narration — one short paragraph of model prose that
   * introduced the current work.
   *
   * Deliberately the most recent COMPLETE text block, not the accumulating
   * `assistantText` stream. The transport EDITS one slot in place, so a live
   * stream would show a half-written sentence that rewrites itself every
   * token; the last finished block is stable until the model actually moves
   * on, which is what makes editing it read as progress rather than flicker.
   *
   * Bounded and single-paragraph: this rides the ephemeral activity slot, not
   * the durable reply. The full prose still arrives in the final message.
   */
  narration: z.string().min(1).max(400).optional(),
  /**
   * Most recent tools, oldest first, capped by the projector.
   *
   * This exists because `currentTool` alone loses every call that finished
   * between two progress publishes — which is most of them, since a Read or a
   * Grep completes in well under the 1s debounce. A turn that ran six tools
   * would otherwise render as a bare "Working" with no evidence of what ran.
   */
  recentTools: z.array(ownerChatToolSchema).max(12).optional(),
})
export type OwnerChatActivity = z.infer<typeof ownerChatActivitySchema>

/** Lifecycle event for one owner-private Agent turn.
 * `accepted` starts transport-native activity without requiring model text.
 * `progress` is ephemeral; final without text silently ends activity. */
export const ownerChatMessageSchema = z.object({
  /** Renewed by Alice while the execution lives; expiry only stops local activity. */
  activityLeaseMs: z.number().int().min(1000).max(120_000).optional(),
  /** Live turn activity. `progress` only; ignored on terminal phases. */
  activity: ownerChatActivitySchema.optional(),
  id: z.string().min(1),
  adapterId: z.string().min(1),
  conversationId: z.string().min(1),
  phase: ownerChatPhaseSchema,
  workspaceId: z.string().min(1).max(128).optional(),
  source: z.enum(['conversation', 'automation']).optional(),
  text: z.string().min(1).max(OWNER_CHAT_TEXT_MAX).optional(),
}).superRefine((message, ctx) => {
  if (message.phase !== 'accepted' && message.phase !== 'final' && !message.text && !message.activity) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['text'],
      message: `${message.phase} owner-chat events require text or activity`,
    })
  }
  if (message.activity && message.phase !== 'progress') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activity'],
      message: 'activity is only meaningful on the progress phase',
    })
  }
})

// ==================== Persistent watcher board ====================

/** Bounds one sync. A pathological workspace must not be able to make the chat
 *  surface allocate an unbounded number of cards. */
export const MAX_WATCHER_BOARD_ITEMS = 50

const watcherBoardRuleSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1).max(64).optional(),
  side: z.string().max(16).optional(),
  level: z.number().finite().optional(),
  low: z.number().finite().optional(),
  high: z.number().finite().optional(),
  timeframe: z.string().max(16).optional(),
  threshold: z.number().finite().nonnegative().optional(),
  thresholdPct: z.number().finite().nonnegative().optional(),
  multiple: z.number().finite().optional(),
  pct: z.number().finite().optional(),
  op: z.string().max(16).optional(),
})

const watcherBoardCandleSchema = z.object({
  timestamp: z.string().min(1),
  open: z.number().finite().optional(),
  high: z.number().finite().optional(),
  low: z.number().finite().optional(),
  close: z.number().finite(),
  volume: z.number().finite().nullable().optional(),
  timeframe: z.string().max(16).optional(),
  confirmed: z.boolean().optional(),
})

const watcherBoardSpecSchema = z.object({
  pair: z.string().min(1).max(64),
  assetClass: z.string().max(32).optional(),
  direction: z.string().max(16).optional(),
  timeframe: z.string().max(16).optional(),
  rules: z.array(watcherBoardRuleSchema).max(32).optional(),
  invalidationRules: z.array(watcherBoardRuleSchema).max(32).optional(),
  managementRules: z.array(watcherBoardRuleSchema).max(32).optional(),
  position: z.object({
    side: z.enum(['LONG', 'SHORT']),
    entry: z.number().finite(),
    stop: z.number().finite().optional(),
    targets: z.array(z.number().finite()).max(10).optional(),
    size: z.number().finite().optional(),
  }).optional(),
  expiry: z.string().min(1).optional(),
  waitingTrigger: z.string().max(500).optional(),
  invalidationConditions: z.array(z.string().max(500)).max(20).optional(),
})

const watcherBoardStateSchema = z.object({
  armedAt: z.string().nullable().optional(),
  lastChecked: z.string().nullable().optional(),
  lastPrice: z.number().finite().nullable().optional(),
  lastMarketTimestamp: z.string().nullable().optional(),
  lastConfirmedCandle: watcherBoardCandleSchema.nullable().optional(),
  previousConfirmedCandle: watcherBoardCandleSchema.nullable().optional(),
  terminal: z.boolean().optional(),
  pollCount: z.number().int().min(0).optional(),
  errorCount: z.number().int().min(0).optional(),
  lastError: z.string().nullable().optional(),
  backoffUntil: z.string().nullable().optional(),
  firedConditions: z.record(z.string(), z.string()).optional(),
})

const watcherBoardMetaSchema = z.object({
  rating: z.union([z.string(), z.number()]).nullable().optional(),
  grade: z.string().nullable().optional(),
  setupPhase: z.string().nullable().optional(),
  nextStep: z.string().max(500).nullable().optional(),
  stopLoss: z.number().finite().nullable().optional(),
  targets: z.union([z.array(z.number().finite()).max(10), z.string().max(200)]).nullable().optional(),
})

const watcherBoardEventSchema = z.object({
  eventType: z.string().min(1),
  message: z.string(),
  at: z.string().optional(),
  price: z.number().finite().nullable().optional(),
})

/** One watcher the connector should render as a persistent, self-updating card.
 *  Alice renders it; the connector owns only the transport identity. */
export const watcherBoardItemSchema = z.object({
  watcherId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  workspaceLabel: z.string().max(128).optional(),
  title: z.string().min(1).max(200),
  running: z.boolean(),
  pollable: z.boolean(),
  pollSeconds: z.number().min(1).max(3600),
  spec: watcherBoardSpecSchema,
  state: watcherBoardStateSchema,
  meta: watcherBoardMetaSchema.optional(),
  events: z.array(watcherBoardEventSchema).max(20).optional(),
  nowIso: z.string().min(1),
})
export type WatcherBoardItem = z.infer<typeof watcherBoardItemSchema>

/**
 * One complete board state push. Idempotent: the connector reconciles its chat
 * messages against `items` and deletes any card whose watcher is no longer
 * listed. `refreshSeconds` tells the connector how fast to re-render locally
 * for the pulse animation — it does NOT trigger a new Alice round-trip.
 */
export const watcherBoardSyncSchema = z.object({
  refreshSeconds: z.number().min(1).max(120).default(5),
  items: z.array(watcherBoardItemSchema).max(MAX_WATCHER_BOARD_ITEMS),
})
export type WatcherBoardSync = z.infer<typeof watcherBoardSyncSchema>
export type OwnerChatMessage = z.infer<typeof ownerChatMessageSchema>

export const inboundOwnerMessageSchema = z.object({
  connectorId: z.string().min(1),
  eventId: z.string().min(1).max(128).optional(),
  userId: z.string().min(1),
  chatId: z.string().min(1).optional(),
  text: z.string().min(1).max(OWNER_CHAT_TEXT_MAX),
})
export type InboundOwnerMessage = z.infer<typeof inboundOwnerMessageSchema>
export type ClaimedInboundOwnerMessage = InboundOwnerMessage & { queueId: string }
export interface ConnectorWorkClaim<T> { claimId: string; items: T[] }
export type ConnectorDeliveryReceipt = z.infer<typeof connectorDeliveryReceiptSchema>

/** Bounded Connector → Alice work that is not phone-desk inbound chat. */
export const MAX_CONNECTOR_ACTION_REQUESTS = 20
export const CONNECTOR_ACTION_TTL_MS = 60_000
export const MAX_CONNECTOR_DOC_INDEX = 999

export const connectorArtifactRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  entryId: z.string().min(1).max(128),
  docIndex: z.number().int().min(0).max(MAX_CONNECTOR_DOC_INDEX),
  createdAt: z.string().datetime(),
})
export type ConnectorArtifactRequest = z.infer<typeof connectorArtifactRequestSchema>

export const connectorArtifactRequestListSchema = z.object({
  requests: z.array(connectorArtifactRequestSchema).max(MAX_CONNECTOR_ACTION_REQUESTS),
})
export type ConnectorArtifactRequestList = z.infer<typeof connectorArtifactRequestListSchema>

/** Directed file delivery. Never an InboxNotification: no title/body re-summary. */
export const connectorArtifactDeliverySchema = z.object({
  requestId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  entryId: z.string().min(1).max(128),
  docIndex: z.number().int().min(0).max(MAX_CONNECTOR_DOC_INDEX),
  attachment: connectorAttachmentSchema,
})
export type ConnectorArtifactDelivery = z.infer<typeof connectorArtifactDeliverySchema>

export const connectorArtifactFailureReasonSchema = z.enum([
  'expired',
  'entry_not_found',
  'workspace_unavailable',
  'doc_not_found',
  'path_escape',
  'file_missing',
  'file_too_large',
  'unsupported',
  'delivery_failed',
])
export type ConnectorArtifactFailureReason = z.infer<typeof connectorArtifactFailureReasonSchema>

export const connectorArtifactFailureSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  entryId: z.string().min(1).max(128),
  docIndex: z.number().int().min(0).max(MAX_CONNECTOR_DOC_INDEX),
  reason: connectorArtifactFailureReasonSchema,
  message: z.string().min(1).max(500),
})
export type ConnectorArtifactFailure = z.infer<typeof connectorArtifactFailureSchema>

export function isConnectorActionExpired(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt)
  return !Number.isFinite(created) || now - created > CONNECTOR_ACTION_TTL_MS
}

/** Owner UTA review / push / reject. Not phone-desk inbound and not Inbox. */
export const MAX_CONNECTOR_UTA_ACCOUNTS = 8
export const MAX_CONNECTOR_UTA_OPERATIONS = 8

/**
 * Owner-initiated watcher management from a chat surface.
 *
 * The connector cannot mutate watch state itself \u2014 Alice owns it \u2014 so a card's
 * Delete button enqueues this and Alice performs the removal. That keeps the
 * watch store single-writer, which is what makes the board a VIEW rather than
 * a second source of truth.
 */
export const MAX_CONNECTOR_WATCH_REQUESTS = 20

export const connectorWatchActionSchema = z.enum(['delete'])
export type ConnectorWatchAction = z.infer<typeof connectorWatchActionSchema>

export const connectorWatchRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  action: connectorWatchActionSchema,
  /** The owning workspace. A watcher id is only unique within a workspace. */
  workspaceId: z.string().min(1).max(128),
  /** The Issue id, which is also the watcher id. */
  watcherId: z.string().min(1).max(64),
})
export type ConnectorWatchRequest = z.infer<typeof connectorWatchRequestSchema>

export const connectorWatchRequestListSchema = z.object({
  requests: z.array(connectorWatchRequestSchema).max(MAX_CONNECTOR_WATCH_REQUESTS),
})
export type ConnectorWatchRequestList = z.infer<typeof connectorWatchRequestListSchema>

export const connectorUtaActionSchema = z.enum(['review', 'push', 'reject'])
export type ConnectorUtaAction = z.infer<typeof connectorUtaActionSchema>

export const connectorUtaRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  action: connectorUtaActionSchema,
  utaId: z.string().min(1).max(64).optional(),
  pendingHash: z.string().min(1).max(16).optional(),
}).superRefine((value, ctx) => {
  if (value.action === 'review') return
  if (!value.utaId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'utaId is required', path: ['utaId'] })
  }
  if (!value.pendingHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pendingHash is required', path: ['pendingHash'] })
  }
})
export type ConnectorUtaRequest = z.infer<typeof connectorUtaRequestSchema>

export const connectorUtaRequestListSchema = z.object({
  requests: z.array(connectorUtaRequestSchema).max(MAX_CONNECTOR_ACTION_REQUESTS),
})
export type ConnectorUtaRequestList = z.infer<typeof connectorUtaRequestListSchema>

export const connectorUtaOperationSchema = z.object({
  action: z.string().min(1).max(40),
  symbol: z.string().max(40).optional(),
  side: z.string().max(8).optional(),
  orderType: z.string().max(16).optional(),
  quantity: z.string().max(32).optional(),
  limitPrice: z.string().max(32).optional(),
  auxPrice: z.string().max(32).optional(),
  summary: z.string().min(1).max(120),
})
export type ConnectorUtaOperation = z.infer<typeof connectorUtaOperationSchema>

export const connectorUtaAccountReviewSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  pendingMessage: z.string().max(200).nullable(),
  pendingHash: z.string().max(16).nullable(),
  stagedCount: z.number().int().min(0).max(100),
  hiddenOperationCount: z.number().int().min(0).max(100).default(0),
  operations: z.array(connectorUtaOperationSchema).max(MAX_CONNECTOR_UTA_OPERATIONS),
})
export type ConnectorUtaAccountReview = z.infer<typeof connectorUtaAccountReviewSchema>

export const connectorUtaReviewSchema = z.object({
  generatedAt: z.string().datetime(),
  unavailable: z.string().max(240).optional(),
  readonly: z.boolean().optional(),
  accounts: z.array(connectorUtaAccountReviewSchema).max(MAX_CONNECTOR_UTA_ACCOUNTS),
  hiddenAccountCount: z.number().int().min(0).max(100).optional(),
})
export type ConnectorUtaReview = z.infer<typeof connectorUtaReviewSchema>

export const connectorUtaResultSchema = z.object({
  kind: z.enum(['pushed', 'rejected', 'error']),
  utaId: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(400),
})
export type ConnectorUtaResult = z.infer<typeof connectorUtaResultSchema>

export const connectorUtaPresentationSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  review: connectorUtaReviewSchema,
  result: connectorUtaResultSchema.optional(),
})
export type ConnectorUtaPresentation = z.infer<typeof connectorUtaPresentationSchema>

export const connectorUtaFailureReasonSchema = z.enum([
  'expired',
  'unavailable',
  'not_found',
  'conflict',
  'readonly',
  'delivery_failed',
])
export type ConnectorUtaFailureReason = z.infer<typeof connectorUtaFailureReasonSchema>

export const connectorUtaFailureSchema = z.object({
  requestId: z.string().min(1).max(64),
  connectorId: z.string().min(1).max(64),
  reason: connectorUtaFailureReasonSchema,
  message: z.string().min(1).max(500),
})
export type ConnectorUtaFailure = z.infer<typeof connectorUtaFailureSchema>

export function utaFailureMessage(reason: ConnectorUtaFailureReason): string {
  switch (reason) {
    case 'expired':
      return 'That UTA review expired. Send /uta again.'
    case 'unavailable':
      return 'Trading is not available. Check OpenAlice trading mode and UTA.'
    case 'not_found':
      return 'That trading account is no longer available. Send /uta again.'
    case 'conflict':
      return 'That pending commit changed. Send /uta again and review it.'
    case 'readonly':
      return 'Trading mode is readonly. Reject is still available; push is not.'
    case 'delivery_failed':
      return 'OpenAlice could not refresh the UTA panel. Send /uta again.'
  }
}

export function artifactFailureMessage(
  reason: ConnectorArtifactFailureReason,
  displayName?: string,
): string {
  const file = displayName?.trim()
  switch (reason) {
    case 'expired':
      return 'That file request expired. Ask for the file again.'
    case 'entry_not_found':
      return 'That Inbox item is no longer available. Send /inbox again.'
    case 'workspace_unavailable':
      return 'OpenAlice could not open that Workspace. Try again when it is available.'
    case 'doc_not_found':
      return 'That file is no longer listed on this Inbox item. Send /inbox again.'
    case 'path_escape':
      return 'That file is outside the Workspace and was not sent.'
    case 'file_missing':
      return file
        ? `The current file ${file} is missing. Try again after it is restored.`
        : 'That file is missing from the Workspace. Try again after it is restored.'
    case 'file_too_large':
      return 'That file is larger than 1 MB and was not sent.'
    case 'unsupported':
      return 'This connector cannot send Inbox files yet.'
    case 'delivery_failed':
      return 'OpenAlice could not send the file. Try again.'
  }
}

/** Missing or non-false means push is on. Existing installs stay noisy. */
export function isInboxPushEnabled(settings: Record<string, string | number | boolean>): boolean {
  return settings.inboxPush !== false
}
