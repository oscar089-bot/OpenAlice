import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { IProvenanceStore } from '../../core/provenance-store.js'
import type { Logger } from '../logger.js'
import { repairUnboundIssueClaims } from './unbound-claim-repair.js'

let root: string
let wsDir: string

const logger = {
  info() {}, warn() {}, error() {}, debug() {}, event() {},
  child() { return logger },
} as unknown as Logger

const provenanceStore = {
  append: async () => ({}),
  list: () => [],
  latest: () => null,
} as unknown as IProvenanceStore

// Deliberately loosely typed: each case supplies a minimal stand-in for the
// real registry records, and the deps contract is re-established by the cast.
function deps(overrides: Record<string, unknown> = {}) {
  return {
    registry: { get: (id: string) => (id === 'ws-1' ? { id: 'ws-1', tag: 'ws-1', dir: wsDir } : undefined) },
    resumeRegistry: { list: () => [] },
    headlessTasks: { latestForResumeId: () => null },
    provenanceStore,
    logger,
    ...overrides,
  } as Parameters<typeof repairUnboundIssueClaims>[0]
}

function issueMd(assignee: string): string {
  return [
    '---',
    'title: Watch SOL',
    'assignee: "' + assignee + '"',
    'when: { kind: every, every: "1h" }',
    '---',
    'Watch SOL.',
    '',
  ].join('\n')
}

async function writeIssue(assignee: string): Promise<void> {
  const dir = join(wsDir, '.alice', 'issues')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sol-watch.md'), issueMd(assignee), 'utf8')
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    resumeId: 'resume-stuck',
    wsId: 'ws-1',
    agent: 'opencode',
    createdAt: 1,
    updatedAt: 1,
    lifecycle: 'active',
    metadata: { createdBy: { kind: 'issue', workspaceId: 'ws-1', issueId: 'sol-watch', policy: 'new-then-resume', fire: 'schedule' } },
    ...overrides,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'unbound-claim-'))
  wsDir = join(root, 'ws-1')
  await mkdir(wsDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('repairUnboundIssueClaims', () => {
  it('releases a first-fire claim whose Session never captured a runtime id', async () => {
    await writeIssue('@resume-stuck')
    const released = await repairUnboundIssueClaims(deps({
      resumeRegistry: { list: () => [identity()] },
      headlessTasks: { latestForResumeId: () => ({ taskId: 'run-x', status: 'interrupted' }) },
    }))
    expect(released).toBe(1)
    const raw = await readFile(join(wsDir, '.alice', 'issues', 'sol-watch.md'), 'utf8')
    expect(raw).toContain('@new-then-resume')
  })

  it('keeps a claim that ever produced a turn', async () => {
    await writeIssue('@resume-stuck')
    const released = await repairUnboundIssueClaims(deps({
      resumeRegistry: { list: () => [identity({ agentSessionId: 'native-1' })] },
      headlessTasks: { latestForResumeId: () => ({ taskId: 'run-x', status: 'done' }) },
    }))
    expect(released).toBe(0)
    const raw = await readFile(join(wsDir, '.alice', 'issues', 'sol-watch.md'), 'utf8')
    expect(raw).toContain('@resume-stuck')
  })

  it('never touches an exact Session assigned outside a first-fire claim', async () => {
    await writeIssue('@resume-stuck')
    const released = await repairUnboundIssueClaims(deps({
      resumeRegistry: { list: () => [identity({ metadata: { createdBy: { kind: 'interactive', surface: 'quick-chat' } } })] },
      headlessTasks: { latestForResumeId: () => ({ taskId: 'run-x', status: 'interrupted' }) },
    }))
    expect(released).toBe(0)
    const raw = await readFile(join(wsDir, '.alice', 'issues', 'sol-watch.md'), 'utf8')
    expect(raw).toContain('@resume-stuck')
  })

  it('does not release a claim the Issue no longer names', async () => {
    await writeIssue('@resume-other')
    const released = await repairUnboundIssueClaims(deps({
      resumeRegistry: { list: () => [identity()] },
      headlessTasks: { latestForResumeId: () => ({ taskId: 'run-x', status: 'interrupted' }) },
    }))
    expect(released).toBe(0)
  })
})
