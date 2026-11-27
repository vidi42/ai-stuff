import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Branch, Entry, Stash, Tab } from '../types'
import { basename, clean, errorText, git } from './git'
import { collapse } from './diff'
import { HISTORY_PAGE, loadTab } from './lists'
import { loadPullRequest, refresh } from './refresh'
import { SNAPSHOT, UI } from './state'

const snapshot = atom({ plugin: 'git-things', key: 'snapshot' } as const, SNAPSHOT, { shape: 'snapshot-1' })
const ui = atom({ plugin: 'git-things', key: 'ui' } as const, UI, { shape: 'ui-1' })

/** Paths per git call, under Windows' command-line limit. */
const CHUNK = 100

/**
 * Runs one action: shows `label` while it runs, refuses a second one meanwhile,
 * shows a failure inline and as a toast, then refreshes.
 */
export async function act($: EngineInterface, label: string, run: (top: string) => Promise<void>): Promise<void> {
  const [{ busy }, { top }] = await Promise.all([read($, ui), read($, snapshot)])
  if (busy) {
    $.ui.toast(`Wait for “${busy}” to finish.`)
    return
  }
  if (!top) return
  await update($, ui, u => ({ ...u, busy: label, error: undefined }))
  try {
    await run(top)
  } catch (err) {
    const message = errorText(err)
    await update($, ui, u => ({ ...u, error: message }))
    $.ui.toast(message.split('\n')[0] ?? message)
  } finally {
    await update($, ui, u => ({ ...u, busy: undefined }))
    await refresh($).catch(() => {})
  }
}

/** Asks before something that cannot be undone; a dismissed question is a no. */
export async function confirm($: EngineInterface, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, { options: [yes, 'Cancel'], header: 'Git' })) === yes
  } catch {
    return false
  }
}

async function inChunks(paths: readonly string[], run: (chunk: string[]) => Promise<unknown>) {
  for (let i = 0; i < paths.length; i += CHUNK) await run(paths.slice(i, i + CHUNK))
}

export function dismissError($: EngineInterface) {
  return update($, ui, u => ({ ...u, error: undefined }))
}

export function setDraft($: EngineInterface, draft: string) {
  return update($, ui, u => (u.draft === draft ? u : { ...u, draft }))
}

export function stage($: EngineInterface, entries: readonly Entry[]) {
  const paths = [...new Set(entries.map(e => e.path))]
  if (paths.length === 0) return Promise.resolve()
  return act($, 'Staging…', top => inChunks(paths, chunk => git($, top, ['add', '-A', '--', ...chunk])))
}

export async function unstage($: EngineInterface, entries: readonly Entry[]) {
  const { isInitial } = await read($, snapshot)
  const paths = [...new Set(entries.flatMap(e => (e.from ? [e.from, e.path] : [e.path])))]
  if (paths.length === 0) return
  return act($, 'Unstaging…', top =>
    inChunks(paths, chunk =>
      // Before the first commit there is no HEAD to restore from.
      git($, top, isInitial ? ['rm', '--cached', '-r', '-q', '--', ...chunk] : ['restore', '--staged', '--', ...chunk]),
    ),
  )
}

export async function unstageAll($: EngineInterface) {
  const { isInitial } = await read($, snapshot)
  return act($, 'Unstaging…', top =>
    git($, top, isInitial ? ['rm', '--cached', '-r', '-q', '.'] : ['reset', '-q']).then(() => {}),
  )
}

/** Discards work-tree changes, deleting untracked files, after asking. */
export async function discard($: EngineInterface, entries: readonly Entry[]) {
  const untracked = entries.filter(e => e.letter === '?').map(e => e.path)
  const tracked = entries.filter(e => e.letter !== '?').map(e => e.path)
  if (untracked.length + tracked.length === 0) return
  const what =
    entries.length === 1 && entries[0]
      ? `${untracked.length ? 'Delete the untracked file' : 'Discard the changes in'} ${basename(entries[0].path)}?`
      : `Discard all ${entries.length} changes?${untracked.length ? ` ${untracked.length} untracked file${untracked.length === 1 ? '' : 's'} will be deleted.` : ''}`
  if (!(await confirm($, `${what} This can't be undone.`, untracked.length && !tracked.length ? 'Delete' : 'Discard'))) return
  return act($, 'Discarding…', async top => {
    await inChunks(tracked, chunk => git($, top, ['restore', '--worktree', '--', ...chunk]))
    await inChunks(untracked, chunk => git($, top, ['clean', '-f', '-q', '--', ...chunk]))
  })
}

/** Commits the staged changes; with none staged, offers to stage everything first. */
export async function commit($: EngineInterface, message?: string): Promise<void> {
  const [u, snap] = await Promise.all([read($, ui), read($, snapshot)])
  const text = (message ?? u.draft).trim()
  if (!text) {
    $.ui.toast('Write a commit message first, or press ✨ Generate.')
    return
  }
  if (snap.entries.length === 0) {
    $.ui.toast('There are no changes to commit.')
    return
  }
  const hasStaged = snap.entries.some(e => e.group === 'staged')
  if (!hasStaged && !(await confirm($, 'There are no staged changes. Stage all your changes and commit them?', 'Stage all and commit'))) {
    return
  }
  // The message is kept in the box until the commit lands.
  await setDraft($, message ?? u.draft)
  await act($, 'Committing…', async top => {
    if (!hasStaged) await git($, top, ['add', '-A'])
    const out = await git($, top, ['commit', '-F', '-'], { stdin: `${text}\n`, timeoutMs: 60000 })
    await setDraft($, '')
    $.ui.toast(clean(out.split('\n')[0] ?? 'Committed.'))
  })
}

const GENERATE_SYSTEM =
  'You write git commit messages. Reply with the message only: no quotes, no code fences, no preamble.'

/** Asks the model for a commit message for the staged changes (or all of them) and puts it in the box. */
export async function generate($: EngineInterface, model: string): Promise<void> {
  const snap = await read($, snapshot)
  if (snap.entries.length === 0) {
    $.ui.toast('There are no changes to describe.')
    return
  }
  await act($, 'Writing a message…', async top => {
    const staged = snap.entries.some(e => e.group === 'staged')
    const base = ['--no-color', '--no-ext-diff', '-M']
    const diff = await git($, top, staged ? ['diff', '--cached', ...base] : snap.isInitial ? ['diff', ...base] : ['diff', 'HEAD', ...base])
    const added = staged ? [] : snap.entries.filter(e => e.letter === '?').map(e => e.path)
    const recent = await git($, top, ['log', '--format=%s', '-10']).catch(() => '')
    const prompt = [
      'Write a commit message for the change below.',
      'First line: at most 72 characters, imperative mood. Add a short body after a blank line only when the change needs explaining.',
      recent.trim() ? `Match the style of this repository's recent subjects:\n${recent.trim()}` : '',
      added.length ? `New files in this change:\n${added.join('\n')}` : '',
      `Diff:\n${diff.length > 20000 ? `${diff.slice(0, 20000)}\n[diff cut short]` : diff}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const r = await $.model.complete({ model, system: GENERATE_SYSTEM, prompt, maxTokens: 400, effort: 'low' })
    if (!r.isAnswered) throw new Error(`Could not write a message (${r.reason}).`)
    const text = r.text
      .trim()
      .replace(/^```\w*\n?/, '')
      .replace(/\n?```$/, '')
      .trim()
    await setDraft($, text)
  })
}

/** Loads what the open tab shows from a timer, so the press that asked is over at once. */
function loadSoon($: EngineInterface) {
  $.clock.after(0, () => void loadTab($).catch(() => {}))
}

export async function setTab($: EngineInterface, tab: Tab) {
  await update($, ui, u => (u.tab === tab ? u : { ...u, tab }))
  loadSoon($)
}

/** Opens a commit's files under it in History or Compare, or closes them; the diff pane keeps what it shows. */
export async function toggleCommit($: EngineInterface, sha: string) {
  const { openCommit } = await read($, ui)
  await update($, ui, u => ({ ...u, openCommit: openCommit === sha ? undefined : sha }))
  if (openCommit !== sha) loadSoon($)
}

/** Opens a stash's files under it, or closes them; the diff pane keeps what it shows. */
export async function toggleStash($: EngineInterface, sha: string) {
  const { openStash } = await read($, ui)
  await update($, ui, u => ({ ...u, openStash: openStash === sha ? undefined : sha }))
  if (openStash !== sha) loadSoon($)
}

export async function loadMoreHistory($: EngineInterface) {
  await update($, ui, u => ({ ...u, historyLimit: (u.historyLimit ?? HISTORY_PAGE) + HISTORY_PAGE }))
  loadSoon($)
}

export function setStashDraft($: EngineInterface, draft: string) {
  return update($, ui, u => (u.stashDraft === draft ? u : { ...u, stashDraft: draft }))
}

/** Stashes every change, untracked files included, with an optional message. */
export async function stashPush($: EngineInterface, message: string) {
  const { entries } = await read($, snapshot)
  if (entries.length === 0) {
    $.ui.toast('There are no changes to stash.')
    return
  }
  await setStashDraft($, message)
  const text = message.trim()
  return act($, 'Stashing…', async top => {
    await git($, top, ['stash', 'push', '--include-untracked', ...(text ? ['-m', text] : [])])
    await setStashDraft($, '')
  })
}

export function stashApply($: EngineInterface, stash: Stash) {
  return act($, `Applying ${stash.ref}…`, top => git($, top, ['stash', 'apply', stash.ref]).then(() => {}))
}

export function stashPop($: EngineInterface, stash: Stash) {
  return act($, `Popping ${stash.ref}…`, top => git($, top, ['stash', 'pop', stash.ref]).then(() => {}))
}

export async function stashDrop($: EngineInterface, stash: Stash) {
  if (!(await confirm($, `Drop ${stash.ref} (${stash.message})? Its changes will be lost.`, 'Drop'))) return
  await act($, `Dropping ${stash.ref}…`, top => git($, top, ['stash', 'drop', stash.ref]).then(() => {}))
}

/** Picks what Compare compares; a commit opened in the old comparison closes. */
export async function setCompare($: EngineInterface, base: string, head: string) {
  const { compareBase, compareHead } = await read($, ui)
  if (compareBase === base && compareHead === head) return
  const { expanded } = await read($, ui)
  await collapse($, expanded.filter(t => t.kind === 'compare'))
  await update($, ui, u => ({ ...u, compareBase: base, compareHead: head }))
  loadSoon($)
}

/** Switches to a local branch, or creates a local branch tracking a remote one. */
export async function switchBranch($: EngineInterface, branch: Branch, locals: readonly Branch[]) {
  if (branch.isCurrent) return
  if (!branch.isRemote) return act($, `Switching to ${branch.name}…`, top => git($, top, ['switch', branch.name]).then(() => {}))
  // origin/feature → feature: switch to the local branch of that name, or create it tracking the remote.
  const local = branch.name.slice(branch.name.indexOf('/') + 1)
  const args = locals.some(b => !b.isRemote && b.name === local) ? ['switch', local] : ['switch', '--track', branch.name]
  return act($, `Switching to ${local}…`, top => git($, top, args).then(() => {}))
}

export function setBranchDraft($: EngineInterface, draft: string) {
  return update($, ui, u => (u.branchDraft === draft ? u : { ...u, branchDraft: draft }))
}

export async function createBranch($: EngineInterface, name: string) {
  const branch = name.trim()
  if (!branch) return
  await setBranchDraft($, name)
  return act($, `Creating ${branch}…`, async top => {
    await git($, top, ['switch', '-c', branch])
    await setBranchDraft($, '')
  })
}

/** Deletes a local branch after asking; offers a force delete when git says it is not merged. */
export async function deleteBranch($: EngineInterface, branch: Branch) {
  if (branch.isRemote || branch.isCurrent) return
  if (!(await confirm($, `Delete the branch ${branch.name}?`, 'Delete'))) return
  let unmerged = false
  await act($, `Deleting ${branch.name}…`, async top => {
    try {
      await git($, top, ['branch', '-d', branch.name])
    } catch (err) {
      if (!/not fully merged/i.test(errorText(err))) throw err
      unmerged = true
    }
  })
  if (!unmerged) return
  if (!(await confirm($, `${branch.name} has commits that are not merged anywhere. Delete it anyway? Those commits will be lost.`, 'Delete anyway'))) return
  await act($, `Deleting ${branch.name}…`, top => git($, top, ['branch', '-D', branch.name]).then(() => {}))
}

const SYNC_MS = 120000

export function fetchAll($: EngineInterface) {
  return act($, 'Fetching…', top => git($, top, ['fetch', '--all', '--prune'], { timeoutMs: SYNC_MS }).then(() => {}))
}

export function pull($: EngineInterface) {
  return act($, 'Pulling…', top => git($, top, ['pull'], { timeoutMs: SYNC_MS }).then(() => {}))
}

/** Pushes the current branch; one with no upstream is published to origin after asking. */
export async function push($: EngineInterface) {
  const snap = await read($, snapshot)
  if (!snap.branch) {
    $.ui.toast('HEAD is detached: switch to a branch to push.')
    return
  }
  if (snap.upstream) return act($, 'Pushing…', top => git($, top, ['push'], { timeoutMs: SYNC_MS }).then(() => {}))
  const branch = snap.branch
  if (!(await confirm($, `${branch} is not on the remote yet. Publish it to origin?`, 'Publish'))) return
  return act($, `Publishing ${branch}…`, async top => {
    await git($, top, ['push', '-u', 'origin', branch], { timeoutMs: SYNC_MS })
    await loadPullRequest($, top, branch, true)
  })
}

/** Looks up the pull request again now. */
export async function refreshPullRequest($: EngineInterface) {
  const { top, branch } = await read($, snapshot)
  if (top && branch) await loadPullRequest($, top, branch, true)
}
