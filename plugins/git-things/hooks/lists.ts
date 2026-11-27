import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Branch, ChangedFile, Comparison, DiffTarget, History, Stashes } from '../types'
import { errorText, git, LOG_FORMAT, parseChangedFiles, parseLog, parseStashes, STASH_FORMAT } from './git'
import { BRANCHES, COMPARE, FILE_LISTS, HISTORY, SNAPSHOT, STASHES, UI } from './state'

const snapshot = atom({ plugin: 'git-things', key: 'snapshot' } as const, SNAPSHOT, { shape: 'snapshot-1' })
const ui = atom({ plugin: 'git-things', key: 'ui' } as const, UI, { shape: 'ui-1' })
const branches = atom({ plugin: 'git-things', key: 'branches' } as const, BRANCHES, { shape: 'branches-1' })
const history = atom({ plugin: 'git-things', key: 'history' } as const, HISTORY, { shape: 'history-1' })
const stashes = atom({ plugin: 'git-things', key: 'stashes' } as const, STASHES, { shape: 'stashes-1' })
const compare = atom({ plugin: 'git-things', key: 'compare' } as const, COMPARE, { shape: 'compare-1' })
const fileLists = atom({ plugin: 'git-things', key: 'fileLists' } as const, FILE_LISTS, { shape: 'fileLists-1' })

/** Commits History lists at first, and adds with each Load more. */
export const HISTORY_PAGE = 50
/** Commits Compare lists at most. */
export const COMPARE_COMMITS = 100

/** Equal but for when it was loaded: keep the old value, so the pane does not redraw every poll. */
const same = (a: { loadedAt: number }, b: { loadedAt: number }) =>
  JSON.stringify({ ...a, loadedAt: 0 }) === JSON.stringify({ ...b, loadedAt: 0 })

export async function loadHistory($: EngineInterface, top: string): Promise<void> {
  const limit = (await read($, ui)).historyLimit ?? HISTORY_PAGE
  let next: History
  try {
    // One past the limit says whether Load more has anything to load.
    const commits = parseLog(await git($, top, ['log', `-n${limit + 1}`, `--format=${LOG_FORMAT}`]))
    next = { commits: commits.slice(0, limit), hasMore: commits.length > limit, loadedAt: Date.now() }
  } catch (err) {
    const message = errorText(err)
    next = /does not have any commits|bad default revision/i.test(message)
      ? { commits: [], hasMore: false, loadedAt: Date.now() }
      : { commits: [], hasMore: false, error: message, loadedAt: Date.now() }
  }
  await update($, history, prev => (same(prev, next) ? prev : next))
}

export async function loadStashes($: EngineInterface, top: string): Promise<void> {
  let next: Stashes
  try {
    next = { list: parseStashes(await git($, top, ['stash', 'list', `--format=${STASH_FORMAT}`])), loadedAt: Date.now() }
  } catch (err) {
    next = { list: [], error: errorText(err), loadedAt: Date.now() }
  }
  await update($, stashes, prev => (same(prev, next) ? prev : next))
}

/** What Compare starts from: the remote's main line, else a local one, never `head` itself. */
export function defaultBase(list: readonly Branch[], head: string): string {
  const names = list.map(b => b.name).filter(n => n !== head)
  return ['origin/main', 'origin/master', 'main', 'master'].find(n => names.includes(n)) ?? names[0] ?? ''
}

export async function loadCompare($: EngineInterface, top: string): Promise<void> {
  const [u, snap, list] = await Promise.all([read($, ui), read($, snapshot), read($, branches)])
  const head = u.compareHead || snap.branch || 'HEAD'
  const base = u.compareBase || defaultBase(list, head)
  let next: Comparison
  if (!base) {
    next = { base, head, commits: [], files: [], error: 'There is no other branch to compare with.', loadedAt: Date.now() }
  } else {
    try {
      const range = `${base}...${head}`
      const flags = ['-z', '-M', '--no-ext-diff', range]
      const [log, names, numstat] = await Promise.all([
        git($, top, ['log', `-n${COMPARE_COMMITS}`, `--format=${LOG_FORMAT}`, `${base}..${head}`]),
        git($, top, ['diff', '--name-status', ...flags]),
        git($, top, ['diff', '--numstat', ...flags]),
      ])
      const files = parseChangedFiles(names, numstat).map(f => ({
        ...f,
        target: { kind: 'compare', ref: range, path: f.path, from: f.from } as DiffTarget,
      }))
      next = { base, head, commits: parseLog(log), files, loadedAt: Date.now() }
    } catch (err) {
      next = { base, head, commits: [], files: [], error: errorText(err), loadedAt: Date.now() }
    }
  }
  await update($, compare, prev => (same(prev, next) ? prev : next))
}

/** The files `git show` / `git diff` lists for one commit or range, with the target each opens. */
async function changedFiles(
  $: EngineInterface,
  top: string,
  args: readonly string[],
  target: (f: { path: string; from?: string }) => DiffTarget,
): Promise<ChangedFile[]> {
  const [names, numstat] = await Promise.all([
    git($, top, [...args.slice(0, 1), '--name-status', ...args.slice(1)]),
    git($, top, [...args.slice(0, 1), '--numstat', ...args.slice(1)]),
  ])
  return parseChangedFiles(names, numstat).map(f => ({ ...f, target: target(f) }))
}

/**
 * Loads the files of a commit (`commit|<sha>`) or a stash (`stash|<sha>`) once:
 * both are fixed, so a loaded list is kept. A stash lists its tracked changes
 * against the commit it was made on, then its untracked files, from `<sha>^3`.
 */
export async function loadFileList($: EngineInterface, top: string, key: string): Promise<void> {
  if ((await read($, fileLists))[key]) return
  const [kind, sha = ''] = key.split('|')
  let entry: { files: ChangedFile[]; error?: string; loadedAt: number }
  try {
    if (kind === 'commit') {
      const files = await changedFiles($, top, ['show', '--first-parent', '-z', '-M', '--format=', sha], f => ({
        kind: 'commit',
        ref: sha,
        path: f.path,
        from: f.from,
      }))
      entry = { files, loadedAt: Date.now() }
    } else {
      const tracked = await changedFiles($, top, ['diff', '-z', '-M', `${sha}^1`, sha], f => ({
        kind: 'stash',
        ref: sha,
        path: f.path,
        from: f.from,
      }))
      // Only a stash made with --include-untracked has a third parent.
      const untracked = await changedFiles($, top, ['show', '-z', '--format=', `${sha}^3`], f => ({
        kind: 'commit',
        ref: `${sha}^3`,
        path: f.path,
      })).catch(() => [])
      // `?` draws as U, untracked.
      entry = { files: [...tracked, ...untracked.map(f => ({ ...f, letter: '?' }))], loadedAt: Date.now() }
    }
  } catch (err) {
    entry = { files: [], error: errorText(err), loadedAt: Date.now() }
  }
  await update($, fileLists, prev => ({ ...prev, [key]: entry }))
}

/** Loads what the open tab shows; the Changes and Branches tabs load with every refresh. */
export async function loadTab($: EngineInterface): Promise<void> {
  const [{ top }, u] = await Promise.all([read($, snapshot), read($, ui)])
  if (!top) return
  if (u.tab === 'history') await loadHistory($, top)
  if (u.tab === 'stash') await loadStashes($, top)
  if (u.tab === 'compare') await loadCompare($, top)
  if (u.openCommit && (u.tab === 'history' || u.tab === 'compare')) await loadFileList($, top, `commit|${u.openCommit}`)
  if (u.openStash && u.tab === 'stash') await loadFileList($, top, `stash|${u.openStash}`)
}
