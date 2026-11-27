import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { DiffTarget, Entry, GitSnapshot, PullRequest } from '../types'
import { collapse, reloadDiffs } from './diff'
import { loadTab } from './lists'
import { BRANCH_FORMAT, clean, errorText, git, githubRepo, newPrUrl, parseBranches, parseNumstat, parseStatus } from './git'
import { BRANCHES, PR, SNAPSHOT, UI } from './state'

const snapshot = atom({ plugin: 'git-things', key: 'snapshot' } as const, SNAPSHOT, { shape: 'snapshot-1' })
const ui = atom({ plugin: 'git-things', key: 'ui' } as const, UI, { shape: 'ui-1' })
const branches = atom({ plugin: 'git-things', key: 'branches' } as const, BRANCHES, { shape: 'branches-1' })
const pr = atom({ plugin: 'git-things', key: 'pr' } as const, PR, { shape: 'pr-1' })

/** How often the pull request is looked up again for the same branch. */
const PR_EVERY_MS = 120000

/** The diff target a Changes-tab entry opens. */
export function entryTarget(entry: Entry): DiffTarget {
  if (entry.group === 'staged') return { kind: 'staged', path: entry.path, from: entry.from }
  if (entry.letter === '?') return { kind: 'untracked', path: entry.path }
  return { kind: 'worktree', path: entry.path }
}

/** Whether a Changes-tab diff still has its entry; commit, stash and compare diffs always do. */
function stillThere(t: DiffTarget, entries: readonly Entry[]): boolean {
  if (t.kind === 'staged') return entries.some(e => e.group === 'staged' && e.path === t.path)
  if (t.kind === 'worktree') return entries.some(e => e.group !== 'staged' && e.letter !== '?' && e.path === t.path)
  if (t.kind === 'untracked') return entries.some(e => e.letter === '?' && e.path === t.path)
  return true
}

let inFlight = false
let topOf: { root: string; top?: string } | undefined

/** Re-reads the repository's status; keeps open Changes-tab diffs current. */
export async function refresh($: EngineInterface): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const root = await $.session.cwd()
    let next: GitSnapshot
    try {
      const r = await $.process.run(
        ['git', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
        // A status that only reads takes no lock another git might wait on.
        { cwd: root, timeoutMs: 15000, env: { GIT_OPTIONAL_LOCKS: '0' } },
      )
      if (r.exitCode !== 0) {
        next = {
          root,
          entries: [],
          ahead: 0,
          behind: 0,
          error: /not a git repository/i.test(r.stderr)
            ? 'This folder is not a git repository.'
            : clean(r.stderr.trim()) || `git exited with ${r.exitCode}`,
          checkedAt: Date.now(),
        }
      } else {
        if (topOf?.root !== root) {
          const top = await git($, root, ['rev-parse', '--show-toplevel']).catch(() => undefined)
          topOf = { root, top: top?.trim() }
        }
        const top = topOf.top
        const parsed = parseStatus(r.stdout)
        if (top) {
          const flags = ['--numstat', '-z', '-M', '--no-ext-diff']
          const [staged, worktree] = await Promise.all([
            git($, top, ['diff', '--cached', ...flags]).catch(() => ''),
            git($, top, ['diff', ...flags]).catch(() => ''),
          ])
          const counts = { staged: parseNumstat(staged), changes: parseNumstat(worktree) }
          parsed.entries = parsed.entries.map(e =>
            e.group === 'merge' ? e : { ...e, ...counts[e.group].get(e.path) },
          )
        }
        next = { root, top, ...parsed, checkedAt: Date.now() }
      }
    } catch (err) {
      next = { root, entries: [], ahead: 0, behind: 0, error: `Could not run git: ${errorText(err)}`, checkedAt: Date.now() }
    }

    await update($, snapshot, prev => {
      const same = JSON.stringify({ ...prev, checkedAt: 0 }) === JSON.stringify({ ...next, checkedAt: 0 })
      // Keep the old value when nothing changed, so the pane does not redraw every poll.
      return same ? prev : next
    })

    const count = new Set(next.entries.map(e => e.path)).size
    const ahead = next.ahead > 0 ? ` ↑${next.ahead}` : ''
    $.ui.status(next.error ? undefined : (count === 0 ? '✓ clean' : `● ${count} change${count === 1 ? '' : 's'}`) + ahead)

    if (next.top) {
      await loadBranches($, next.top)
      if (next.branch) await loadPullRequest($, next.top, next.branch)
      // History, Stash and Compare load only while open.
      await loadTab($)
    }

    // A file's content can change while its status stays: keep open diffs current,
    // and close those whose file left its group (staged, committed, reverted).
    const { expanded } = await read($, ui)
    const gone = expanded.filter(t => !stillThere(t, next.entries))
    if (gone.length > 0) await collapse($, gone)
    if (next.top) {
      const current = expanded.filter(
        t => (t.kind === 'staged' || t.kind === 'worktree' || t.kind === 'untracked') && stillThere(t, next.entries),
      )
      await reloadDiffs($, next.top, current)
    }
  } finally {
    inFlight = false
  }
}

/** Re-reads the local and remote branches; keeps the old value when nothing changed. */
export async function loadBranches($: EngineInterface, top: string): Promise<void> {
  const out = await git($, top, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']).catch(() => undefined)
  if (out === undefined) return
  const list = parseBranches(out)
  await update($, branches, prev => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list))
}

/**
 * Looks up the current branch's pull request with the GitHub CLI when the
 * branch changed, every two minutes, or when `force`. Without `gh`, or with
 * no PR, offers GitHub's page for opening one, except on the default branch.
 */
export async function loadPullRequest($: EngineInterface, top: string, branch: string, force = false): Promise<void> {
  const known = await read($, pr)
  if (!force && known.branch === branch && Date.now() - known.checkedAt < PR_EVERY_MS) return
  const next: PullRequest = { branch, checkedAt: Date.now() }
  try {
    const r = await $.process.run(['gh', 'pr', 'view', branch, '--json', 'number,url,state,isDraft,title'], {
      cwd: top,
      timeoutMs: 20000,
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    })
    if (r.exitCode === 0) {
      const found = JSON.parse(r.stdout) as { number: number; url: string; state: string; isDraft: boolean; title: string }
      Object.assign(next, { number: found.number, url: found.url, state: found.state, isDraft: found.isDraft, title: clean(found.title) })
    }
  } catch {
    // No gh on this machine: fall back to the remote's URL below.
  }
  if (!next.url) {
    const remote = await git($, top, ['remote', 'get-url', 'origin']).catch(() => '')
    const repo = githubRepo(remote)
    const head = await git($, top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
    const isDefault = head.trim() ? head.trim() === `origin/${branch}` : branch === 'main' || branch === 'master'
    if (repo && !isDefault) next.createUrl = newPrUrl(repo, branch)
  }
  await update($, pr, prev =>
    JSON.stringify({ ...prev, checkedAt: 0 }) === JSON.stringify({ ...next, checkedAt: 0 }) ? { ...prev, checkedAt: next.checkedAt } : next,
  )
}
