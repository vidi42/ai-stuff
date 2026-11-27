import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { DiffEntry, DiffSection, DiffTarget } from '../types'
import { clean, errorText, git } from './git'
import { DIFFS, SNAPSHOT, UI } from './state'

const diffs = atom({ plugin: 'git-things', key: 'diffs' } as const, DIFFS, { shape: 'diffs-1' })
const snapshot = atom({ plugin: 'git-things', key: 'snapshot' } as const, SNAPSHOT, { shape: 'snapshot-1' })
const ui = atom({ plugin: 'git-things', key: 'ui' } as const, UI, { shape: 'ui-1' })

/** Room for one file's hunks; the pane shares a larger budget across the open files. */
const FILE_BUDGET = 60000

export const NO_DIFF: DiffEntry = { sections: [], added: 0, removed: 0, omitted: 0, size: 0, loadedAt: 0 }

export const targetKey = (t: DiffTarget) => `${t.kind}|${t.ref ?? ''}|${t.path}`

/** Header lines that `<Code format="diff">` has no use for and the pane does not show. */
const PLUMBING = /^(diff --git |index |--- |\+\+\+ )/

/**
 * Keeps the start of a hunk that does not fit, renumbering its header so the
 * cut still parses as a hunk. Undefined when not even one line fits.
 */
function cutHunk(hunk: string[], room: number): string[] | undefined {
  const head = hunk[0] ?? ''
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(head)
  if (!m) return undefined
  const body: string[] = []
  let used = head.length + 1
  let oldCount = 0
  let newCount = 0
  for (const line of hunk.slice(1)) {
    if (used + line.length + 1 > room) break
    used += line.length + 1
    body.push(line)
    if (line[0] !== '+' && line[0] !== '\\') oldCount++
    if (line[0] !== '-' && line[0] !== '\\') newCount++
  }
  if (body.length === 0) return undefined
  return [`@@ -${m[1]},${oldCount} +${m[2]},${newCount} @@${m[3] ?? ''}`, ...body]
}

/** Splits `git diff` output into one section per file, within `budget` characters. */
export function parseDiff(out: string, budget = FILE_BUDGET): Omit<DiffEntry, 'loadedAt' | 'error'> {
  const lines = clean(out).split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  type File = { title: string; notes: string[]; hunks: string[][] }
  const files: File[] = []
  let file: File | undefined
  let hunk: string[] | undefined
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (!file || line.startsWith('diff --git ')) {
      file = { title: /^diff --git a\/.* b\/(.*)$/.exec(line)?.[1] ?? '', notes: [], hunks: [] }
      files.push(file)
      hunk = undefined
    }
    if (line.startsWith('@@')) {
      hunk = [line]
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (line.startsWith('+++ b/')) file.title = line.slice(6)
      else if (line.startsWith('--- a/') && !file.title) file.title = line.slice(6)
      if (!PLUMBING.test(line) && line.trim()) file.notes.push(line)
      continue
    }
    hunk.push(line)
    if (line[0] === '+') added++
    else if (line[0] === '-') removed++
  }

  let used = 0
  let omitted = 0
  const sections: DiffSection[] = files.map(f => {
    const kept: string[] = []
    for (const h of f.hunks) {
      const size = h.reduce((n, l) => n + l.length + 1, 0)
      if (omitted === 0 && used + size <= budget) {
        kept.push(...h)
        used += size
        continue
      }
      // Past the budget: keep what fits of this hunk, and none of the rest.
      const cut = omitted === 0 ? cutHunk(h, budget - used) : undefined
      if (cut) {
        kept.push(...cut)
        used += cut.reduce((n, l) => n + l.length + 1, 0)
      }
      omitted += h.length - (cut?.length ?? 0) || 1
    }
    return { title: f.title, notes: f.notes, hunks: kept.join('\n') }
  })
  return { sections, added, removed, omitted, size: used }
}

/** The git command that prints a target's diff, and the exit codes that mean it worked. */
export function diffCommand(t: DiffTarget): { args: string[]; ok: number[] } {
  const flags = ['--no-color', '--no-ext-diff', '-M']
  const paths = t.from ? [t.from, t.path] : [t.path]
  switch (t.kind) {
    case 'staged':
      return { args: ['diff', '--cached', ...flags, '--', ...paths], ok: [0] }
    case 'worktree':
      return { args: ['diff', ...flags, '--', t.path], ok: [0] }
    case 'untracked':
      // Exits 1 when the two differ, which a new file always does.
      return { args: ['diff', '--no-index', ...flags, '--', '/dev/null', t.path], ok: [0, 1] }
    case 'commit':
      // Against the first parent; a root commit shows whole.
      return { args: ['show', '--format=', '--first-parent', ...flags, t.ref ?? 'HEAD', '--', ...paths], ok: [0] }
    case 'stash': {
      // A stash's tracked changes, against the commit it was made on: `stash show`
      // takes no path, so diff the stash commit with its first parent. Its untracked
      // files live in a commit of their own (`<stash>^3`), shown as `commit` targets.
      const ref = t.ref ?? 'stash@{0}'
      return { args: ['diff', ...flags, `${ref}^1`, ref, '--', ...paths], ok: [0] }
    }
    case 'compare':
      return { args: ['diff', ...flags, t.ref ?? 'HEAD', '--', ...paths], ok: [0] }
  }
}

/** Runs git for a target's diff and parses it; a failure becomes the entry's error. */
async function computeDiff($: EngineInterface, top: string, t: DiffTarget): Promise<DiffEntry> {
  try {
    const { args, ok } = diffCommand(t)
    return { ...parseDiff(await git($, top, args, { ok })), loadedAt: Date.now() }
  } catch (err) {
    return { ...NO_DIFF, error: errorText(err), loadedAt: Date.now() }
  }
}

/**
 * Writes loaded diffs into the cache in one write, so the pane redraws once.
 * Skips a diff collapsed while it loaded, and one that did not change.
 */
async function store($: EngineInterface, loaded: readonly [string, DiffEntry][]): Promise<void> {
  await update($, diffs, prev => {
    let next = prev
    for (const [key, entry] of loaded) {
      if (!(key in prev)) continue
      const old = prev[key]
      const same =
        old !== undefined &&
        old.loadedAt !== 0 &&
        JSON.stringify({ ...old, loadedAt: 0 }) === JSON.stringify({ ...entry, loadedAt: 0 })
      if (same) continue
      if (next === prev) next = { ...prev }
      next[key] = entry
    }
    return next
  })
}

/** Loads a target's diff into the cache; keeps the old value when nothing changed. */
export async function loadDiff($: EngineInterface, top: string, t: DiffTarget): Promise<void> {
  await store($, [[targetKey(t), await computeDiff($, top, t)]])
}

/** Diffs loaded at once; each batch is written, and drawn, together. */
const BATCH = 6
let loading = false

/** Reloads loaded diffs (a refresh keeping them current), a batch at a time, one write per batch. */
export async function reloadDiffs($: EngineInterface, top: string, targets: readonly DiffTarget[]): Promise<void> {
  const cache = await read($, diffs)
  // Diffs still loading are loadPending's.
  const loaded = targets.filter(t => (cache[targetKey(t)]?.loadedAt ?? 0) !== 0)
  for (let i = 0; i < loaded.length; i += BATCH) {
    const batch = loaded.slice(i, i + BATCH)
    await store($, await Promise.all(batch.map(async t => [targetKey(t), await computeDiff($, top, t)] as [string, DiffEntry])))
  }
}

/**
 * Loads every open diff that has not loaded yet, a batch at a time, until none
 * is left. Runs from a timer, not from a press, so the pane stays usable
 * meanwhile: a collapse lands at once, and its diffs are skipped.
 */
async function loadPending($: EngineInterface): Promise<void> {
  if (loading) return
  loading = true
  try {
    for (;;) {
      const [{ top }, { expanded }, cache] = await Promise.all([read($, snapshot), read($, ui), read($, diffs)])
      if (!top) return
      const pending = expanded.filter(t => cache[targetKey(t)]?.loadedAt === 0).slice(0, BATCH)
      if (pending.length === 0) return
      const loaded = await Promise.all(pending.map(async t => [targetKey(t), await computeDiff($, top, t)] as [string, DiffEntry]))
      await store($, loaded)
    }
  } finally {
    loading = false
  }
}

export const isExpanded = (expanded: readonly DiffTarget[], t: DiffTarget) =>
  expanded.some(x => targetKey(x) === targetKey(t))

/** The pane that draws diffs, apart from the lists, so a diff gets a drawing of its own. */
export const DIFF_PANE = 'git-things-diff'
/** Files the diff pane shows at most at once. */
const SHOWN_MAX = 50

/**
 * Shows `targets` in the diff pane, in place of what it showed, and opens it.
 * Returns once they show "Loading…"; a timer loads them, so the press is over at once.
 */
export async function showDiffs($: EngineInterface, targets: readonly DiffTarget[], title: string): Promise<void> {
  const shown = targets.slice(0, SHOWN_MAX)
  await update($, ui, u => ({ ...u, expanded: shown, diffTitle: title }))
  await update($, diffs, d => {
    const next: Record<string, DiffEntry> = {}
    for (const t of shown) next[targetKey(t)] = d[targetKey(t)] ?? NO_DIFF
    return next
  })
  void $.ui.open({ id: DIFF_PANE, title: `diff · ${title}`, focus: true }).catch(() => {})
  $.clock.after(0, () => void loadPending($).catch(() => {}))
}

/** Empties the diff pane: it was closed, or its list hidden. */
export async function clearDiffs($: EngineInterface): Promise<void> {
  await update($, ui, u => (u.expanded.length === 0 && !u.diffTitle ? u : { ...u, expanded: [], diffTitle: undefined }))
  await update($, diffs, d => (Object.keys(d).length === 0 ? d : {}))
}

/** Closes the diffs of `targets` and drops them from the cache. */
export async function collapse($: EngineInterface, targets: readonly DiffTarget[]): Promise<void> {
  const keys = new Set(targets.map(targetKey))
  await update($, ui, u => {
    const kept = u.expanded.filter(t => !keys.has(targetKey(t)))
    return kept.length === u.expanded.length ? u : { ...u, expanded: kept }
  })
  await update($, diffs, d => {
    if (![...keys].some(k => k in d)) return d
    const next = { ...d }
    for (const k of keys) delete next[k]
    return next
  })
}
