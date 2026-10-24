/**
 * memory_* and skill_* — the agent's write surface for durable learning.
 *
 * These are **workspace-scoped tool factories** because that is the only
 * surface a workspace agent can reach (its `.mcp.json` bakes `/mcp/:wsId`),
 * not because memory is workspace-bound. Memory itself is user-global.
 *
 * Permission model: the store applies **no** gate. The gate is the operating
 * contract in `RULE.md` — the agent must obtain the owner's explicit go-ahead
 * in conversation before calling any mutating tool here. Splitting the two
 * keeps the file layer honest (it does exactly what it is told) and puts the
 * judgement where the conversation is. Reads are always free.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { WorkspaceToolFactory, WorkspaceToolContext } from '../core/workspace-tool-center.js'
import { MEMORY_TYPES } from '../core/memory-store.js'

/** Skill roots in the order the launcher writes them. Both are kept in sync so
 *  Claude Code and Codex/Pi see the same edit. */
const SKILL_ROOTS = ['.claude/skills', '.agents/skills'] as const

const slug = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

function requireStore(ctx: WorkspaceToolContext) {
  if (!ctx.memoryStore) {
    throw new Error('memory is unavailable in this context')
  }
  return ctx.memoryStore
}

export const memoryRecallFactory: WorkspaceToolFactory = {
  name: 'memory_recall',
  build(ctx: WorkspaceToolContext) {
    return tool({
      description: [
        'Search your persistent memory — lessons, corrections, techniques and mistakes you recorded in earlier sessions.',
        '',
        'Call this before starting any analysis, whenever a past correction might apply, or when the user references something you agreed on before. It is free and always allowed.',
        '',
        'An empty query lists everything. Results are matched on title, description and body; all query words must appear.',
      ].join('\n'),
      inputSchema: z.object({
        query: z.string().describe('Space-separated words to match. Empty string returns every entry.'),
      }),
      execute: async ({ query }) => {
        try {
          const entries = await requireStore(ctx).search(query)
          return {
            ok: true as const,
            count: entries.length,
            memories: entries.slice(0, 20).map((entry) => ({
              id: entry.id,
              title: entry.title,
              type: entry.type,
              content: entry.body,
            })),
          }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
}

export const memorySaveFactory: WorkspaceToolFactory = {
  name: 'memory_save',
  build(ctx: WorkspaceToolContext) {
    return tool({
      description: [
        'Record a durable lesson in your persistent memory. It is injected into every future session, so write it to be read cold, months later, with no context.',
        '',
        'DO NOT CALL THIS WITHOUT THE USER\'S EXPLICIT APPROVAL IN THIS CONVERSATION. Ask first, state exactly what you will record, and wait for a clear yes. A correction during a turn is not approval to write memory; the owner must grant it.',
        '',
        'What belongs here:',
        '- a correction, with its CONDITION: when does the lesson apply, and when does it not?',
        '- a technique that worked, and the setup it worked in',
        '- a mistake you must never repeat, and how to recognise the moment before it',
        '- a user preference that should hold across sessions',
        '',
        'What does not: prices, current positions, one-off facts, or anything a tool returns fresh. If it expires, it is not memory.',
        '',
        'Types: `feedback` (a correction or lesson), `user` (who the user is and how they want you to work), `project` (durable context about ongoing work), `reference` (a pointer to a source or method).',
      ].join('\n'),
      inputSchema: z.object({
        title: z.string().min(1).describe('A SHORT label, ideally 2-5 words, e.g. "Watcher timing rule". Never a sentence - it becomes the filename and the index line. Reusing a title overwrites that entry.'),
        content: z.string().min(1).describe('The lesson itself. State the rule AND its condition.'),
        type: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe('Defaults to project.'),
        description: z.string().optional().describe('One line for the index. Defaults to the title.'),
      }),
      execute: async ({ title, content, type, description }) => {
        try {
          const entry = await requireStore(ctx).save({
            title,
            content,
            ...(type ? { type } : {}),
            ...(description ? { description } : {}),
          })
          return { ok: true as const, id: entry.id, title: entry.title, type: entry.type }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
}

export const memoryForgetFactory: WorkspaceToolFactory = {
  name: 'memory_forget',
  build(ctx: WorkspaceToolContext) {
    return tool({
      description: [
        'Delete one entry from persistent memory by id or exact title.',
        '',
        'DO NOT CALL THIS WITHOUT THE USER\'S EXPLICIT APPROVAL. Ask first and wait for a clear yes.',
        '',
        'Use `memory_recall` to find the id. Deleting an entry removes it from every future session, so prefer correcting it with `memory_save` when the lesson is still mostly right.',
      ].join('\n'),
      inputSchema: z.object({
        id: z.string().optional().describe('Entry id from memory_recall. Preferred.'),
        title: z.string().optional().describe('Exact title, when the id is unknown.'),
        type: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe('Only needed when the same title exists under several types.'),
      }),
      execute: async ({ id, title, type }) => {
        try {
          const store = requireStore(ctx)
          if (id) {
            const removed = await store.remove(id)
            return removed ? { ok: true as const, removed: id } : { ok: false as const, error: `no memory with id ${id}` }
          }
          if (!title) return { ok: false as const, error: 'provide id or title' }
          const removed = await store.removeByTitle(title, type)
          return removed ? { ok: true as const, removed: title } : { ok: false as const, error: `no memory titled ${title}` }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
}

/** Resolve the workspace dir, or report why skill editing is unavailable. */
function workspaceDir(ctx: WorkspaceToolContext): string | null {
  return ctx.resolveWorkspace?.(ctx.workspaceId)?.dir ?? null
}

async function readExistingSkill(dir: string, name: string): Promise<{ path: string; content: string } | null> {
  for (const root of SKILL_ROOTS) {
    const path = join(dir, root, name, 'SKILL.md')
    try {
      return { path, content: await readFile(path, 'utf-8') }
    } catch {
      // Try the next root.
    }
  }
  return null
}

async function writeSkill(dir: string, name: string, content: string): Promise<string[]> {
  const written: string[] = []
  for (const root of SKILL_ROOTS) {
    const folder = join(dir, root, name)
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'SKILL.md')
    const tmp = `${path}.tmp`
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, path)
    written.push(path)
  }
  return written
}

export const skillPatchFactory: WorkspaceToolFactory = {
  name: 'skill_patch',
  build(ctx: WorkspaceToolContext) {
    return tool({
      description: [
        'Fix or extend one of this Workspace\'s skills by exact find-and-replace. Both the Claude and the Codex/Pi copies are updated so the agent sees one skill, not two.',
        '',
        'DO NOT CALL THIS WITHOUT THE USER\'S EXPLICIT APPROVAL IN THIS CONVERSATION. Ask first, quote the exact text you will change, and wait for a clear yes.',
        '',
        'Use this when a skill\'s API shape is wrong, a step is missing, or a corrected method should become the default next time. `find` must match exactly one occurrence of real text in the current SKILL.md — read the file first rather than guessing.',
      ].join('\n'),
      inputSchema: z.object({
        name: z.string().min(1).describe('Skill folder name, e.g. "smcpro".'),
        find: z.string().min(1).describe('Exact text currently in SKILL.md. Must occur exactly once.'),
        replace: z.string().describe('Replacement text.'),
      }),
      execute: async ({ name, find, replace }) => {
        try {
          const dir = workspaceDir(ctx)
          if (!dir) return { ok: false as const, error: 'workspace resolution is unavailable in this context' }
          const folder = slug(name)
          if (!folder) return { ok: false as const, error: 'invalid skill name' }
          const existing = await readExistingSkill(dir, folder)
          if (!existing) return { ok: false as const, error: `skill not found: ${folder}` }

          const first = existing.content.indexOf(find)
          if (first === -1) return { ok: false as const, error: `text not found in skill ${folder}` }
          if (existing.content.indexOf(find, first + 1) !== -1) {
            return { ok: false as const, error: 'text occurs more than once; include more surrounding context to disambiguate' }
          }

          const patched = existing.content.slice(0, first) + replace + existing.content.slice(first + find.length)
          const written = await writeSkill(dir, folder, patched)
          return { ok: true as const, skill: folder, files: written }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
}

export const skillListFactory: WorkspaceToolFactory = {
  name: 'skill_list',
  build(ctx: WorkspaceToolContext) {
    return tool({
      description:
        'List the skills installed in this Workspace, with a one-line description from each SKILL.md frontmatter. Free to call.',
      inputSchema: z.object({}),
      execute: async () => {
        const dir = workspaceDir(ctx)
        if (!dir) return { ok: false as const, error: 'workspace resolution is unavailable in this context' }
        try {
          const names = new Set<string>()
          for (const root of SKILL_ROOTS) {
            try {
              for (const entry of await readdir(join(dir, root), { withFileTypes: true })) {
                if (entry.isDirectory()) names.add(entry.name)
              }
            } catch {
              // Root may not exist in a bare workspace.
            }
          }
          const skills = await Promise.all(
            [...names].sort().map(async (name) => {
              const found = await readExistingSkill(dir, name)
              const description = found ? /^description:\s*(.+)$/m.exec(found.content)?.[1]?.trim() ?? '' : ''
              return { name, description }
            }),
          )
          return { ok: true as const, count: skills.length, skills }
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  },
}

/** Registered as one bundle so `src/main.ts` stays a short list. */
export const memoryToolFactories: readonly WorkspaceToolFactory[] = [
  memoryRecallFactory,
  memorySaveFactory,
  memoryForgetFactory,
  skillListFactory,
  skillPatchFactory,
]

/** Exported for the store-shape assertion in tests. */
export const MEMORY_TYPE_VALUES = MEMORY_TYPES
