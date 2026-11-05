import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionAdmission } from './session-admission.js'
const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const user = { kind: 'user' as const, entry: 'control' }
const system = { kind: 'system' as const, entry: 'scheduler' }
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'admission-')); dirs.push(dir)
  const file = join(dir, 'admission.json')
  return { file, admission: await SessionAdmission.open(file) }
}
it('persists cooldown, expires lazily, and never dispatches work', async () => {
  const { file, admission } = await setup()
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  await admission.cooldown('s', 'run', user)
  const restored = await SessionAdmission.open(file)
  expect(restored.blocks('s')[0].expiresAt).toBe(1_600_000)
  expect(() => restored.assertAllowed('s')).toThrow()
  vi.spyOn(Date, 'now').mockReturnValue(1_600_000)
  expect(restored.blocks('s')).toEqual([])
  expect(() => restored.assertAllowed('s')).not.toThrow()
})
it('keeps independent blockers and requires user authority to release one', async () => {
  const { admission } = await setup()
  for (let i = 0; i < 3; i++) await admission.outcome('s', String(i), true, 'startup-failed')
  await admission.cooldown('s', 'user-stop', user)
  const fault = admission.blocks('s').find(row => row.kind === 'execution-fault')!
  await expect(admission.release('s', fault.id, system)).rejects.toThrow('explicit user')
  await admission.release('s', fault.id, user)
  expect(admission.blocks('s').map(row => row.kind)).toEqual(['user-cooldown'])
  await expect(admission.configure(60, system)).rejects.toThrow()
  await admission.configure(120, user)
  expect(admission.cooldownSeconds).toBe(120)
  expect(admission.blocks('s')[0].expiresAt! - admission.blocks('s')[0].createdAt).toBe(600000)
})
it('resets consecutive failures after success', async () => {
  const { admission } = await setup()
  await admission.outcome('s', '1', true, 'exit')
  await admission.outcome('s', '2', true, 'exit')
  await admission.outcome('s', '3', false, 'exit')
  await admission.outcome('s', '4', true, 'exit')
  expect(admission.blocks('s')).toEqual([])
})
it('an execution-fault block expires instead of wedging the Session forever', async () => {
  const { admission } = await setup()
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  for (let i = 0; i < 3; i++) await admission.outcome('s', String(i), true, 'child-exit:0')
  const fault = admission.blocks('s').find(row => row.kind === 'execution-fault')!
  // A bounded lifetime is the whole point: without it a transient streak
  // blocked every future start until a human released it in the web UI, which
  // a Telegram-only user never sees.
  expect(fault.expiresAt).toBe(1_000_000 + 30 * 60_000)
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 30 * 60_000)
  expect(admission.blocks('s')).toEqual([])
  expect(() => admission.assertAllowed('s')).not.toThrow()
})
it('repairs a legacy fault block that was written without an expiry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'admission-')); dirs.push(dir)
  const file = join(dir, 'admission.json')
  // Shape written by the shipped bug: `execution-fault` with no `expiresAt`,
  // which every expiry check treats as permanently active.
  await writeFile(file, JSON.stringify({
    version: 1,
    cooldownSeconds: 600,
    failures: { s: 3 },
    blocks: [{
      id: 'legacy', resumeId: 's', kind: 'execution-fault', createdAt: 1_000_000,
      executionId: 'run', actor: { kind: 'system', entry: 'session-failure-policy' }, reason: 'Three consecutive executions failed.',
    }],
  }))
  // Anchor the clock to the block's own era, so "expires" is observable
  // instead of being filtered out by real wall-clock time.
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const admission = await SessionAdmission.open(file)
  expect(admission.blocks('s')[0]?.expiresAt).toBe(1_000_000 + 30 * 60_000)
  // And once that window passes it no longer blocks a start.
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 30 * 60_000)
  expect(() => admission.assertAllowed('s')).not.toThrow()
})
