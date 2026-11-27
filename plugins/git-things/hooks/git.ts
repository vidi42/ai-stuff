import type { Color, EngineInterface } from 'claude-code'

import type { Branch, ChangedFile, Commit, Entry, GitSnapshot, Stash } from '../types'

/** A git command that exited with a code it was not expected to. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message)
  }
}

/** Text a drawing takes: tab and newline its only control characters. */
export const clean = (text: string) =>
  text.replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�')

export const errorText = (err: unknown) =>
  err instanceof Error ? clean(err.message) : clean(String(err))

/**
 * Runs git in `cwd` and resolves its stdout; rejects with a GitError on an
 * exit code outside `ok`. Never prompts: a missing credential fails instead.
 */
export async function git(
  $: EngineInterface,
  cwd: string,
  args: readonly string[],
  options: { stdin?: string; timeoutMs?: number; ok?: readonly number[] } = {},
): Promise<string> {
  const r = await $.process.run(['git', '-c', 'core.quotepath=off', ...args], {
    cwd,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 15000,
    // Never wait on a person: no credential prompt, no editor for a merge message.
    env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no' },
  })
  if (!(options.ok ?? [0]).includes(r.exitCode)) {
    const said = clean((r.stderr || r.stdout).trim())
    throw new GitError(said || `git ${args[0]} exited with ${r.exitCode}`, r.exitCode)
  }
  return r.stdout
}

/** Splits off the first `count` space-separated fields; the rest is a path that may hold spaces. */
function fieldsThenPath(entry: string, count: number): { fields: string[]; path: string } {
  let at = 0
  for (let i = 0; i < count; i++) at = entry.indexOf(' ', at) + 1
  return { fields: entry.slice(0, at - 1).split(' '), path: entry.slice(at) }
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(
  out: string,
): Pick<GitSnapshot, 'branch' | 'oid' | 'isInitial' | 'upstream' | 'ahead' | 'behind' | 'entries'> {
  const parts = out.split('\0')
  const entries: Entry[] = []
  const head: ReturnType<typeof parseStatus> = { entries, ahead: 0, behind: 0 }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    if (part.startsWith('# ')) {
      const { fields, path: value } = fieldsThenPath(part, 2)
      switch (fields[1]) {
        case 'branch.oid':
          head.isInitial = value === '(initial)'
          head.oid = head.isInitial ? undefined : value.slice(0, 7)
          break
        case 'branch.head':
          head.branch = value === '(detached)' ? undefined : value
          break
        case 'branch.upstream':
          head.upstream = value
          break
        case 'branch.ab': {
          const m = /^\+(\d+) -(\d+)$/.exec(value)
          if (m) {
            head.ahead = Number(m[1])
            head.behind = Number(m[2])
          }
          break
        }
      }
      continue
    }
    if (part.startsWith('? ')) {
      entries.push({ group: 'changes', letter: '?', path: part.slice(2) })
      continue
    }
    const kind = part[0]
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue
    const { fields, path } = fieldsThenPath(part, kind === '1' ? 8 : kind === '2' ? 9 : 10)
    // A rename or copy carries its old path as the next NUL-separated entry.
    const from = kind === '2' ? parts[++i] : undefined
    if (kind === 'u') {
      entries.push({ group: 'merge', letter: 'U', path })
      continue
    }
    const x = fields[1]?.[0] ?? '.'
    const y = fields[1]?.[1] ?? '.'
    if (x !== '.') entries.push({ group: 'staged', letter: x, path, from })
    if (y !== '.') entries.push({ group: 'changes', letter: y, path })
  }
  return head
}

/**
 * Parses `git diff --numstat -z`: lines added and removed per path. A binary
 * file, counted as `-`, is left out; a rename carries its old and new paths
 * as the next two NUL-separated entries.
 */
export function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const parts = out.split('\0')
  const counts = new Map<string, { added: number; removed: number }>()
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i] ?? '')
    if (!m) continue
    let path = m[3] ?? ''
    if (path === '') {
      i += 2
      path = parts[i] ?? ''
    }
    if (m[1] === '-' || m[2] === '-') continue
    counts.set(path, { added: Number(m[1]), removed: Number(m[2]) })
  }
  return counts
}

/**
 * A status letter as one symbol, as VS Code's source control view marks it:
 * M modified, A added, D deleted, R renamed, C copied, T type changed,
 * U untracked, ! conflict.
 */
export function describe(letter: string): { symbol: string; color: Color } {
  switch (letter) {
    case '?': return { symbol: 'U', color: 'subtle' }
    case 'U': return { symbol: '!', color: 'error' }
    case 'A': return { symbol: 'A', color: 'success' }
    case 'D': return { symbol: 'D', color: 'diffRemoved' }
    case 'R': return { symbol: 'R', color: 'suggestion' }
    case 'C': return { symbol: 'C', color: 'suggestion' }
    case 'T': return { symbol: 'T', color: 'warning' }
    default: return { symbol: 'M', color: 'warning' }
  }
}

export const basename = (path: string) => path.replace(/\/$/, '').split('/').pop() ?? path

export const folderOf = (path: string) => {
  const name = basename(path)
  return path.slice(0, path.length - name.length).replace(/\/$/, '')
}

/** The `git for-each-ref` format `parseBranches` reads: NUL-separated fields, one branch per line. */
export const BRANCH_FORMAT =
  '%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(committerdate:relative)%00%(subject)'

/** Parses `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`. */
export function parseBranches(out: string): Branch[] {
  const branches: Branch[] = []
  for (const line of out.replace(/\r/g, '').split('\n')) {
    // Split on NUL first: clean() would turn the separator into a visible character.
    const [ref = '', name = '', upstream = '', track = '', head = '', when = '', subject = ''] = line.split('\0').map(clean)
    // origin/HEAD only points at another remote branch.
    if (!ref || ref.endsWith('/HEAD')) continue
    branches.push({
      name,
      isRemote: ref.startsWith('refs/remotes/'),
      isCurrent: head === '*',
      upstream: upstream || undefined,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      isGone: track === 'gone',
      when,
      subject,
    })
  }
  return branches
}

/** `owner/repo` of a GitHub remote URL (https or ssh); undefined for any other host. */
export function githubRepo(url: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : undefined
}

/** GitHub's page for opening a pull request from `branch`. */
export const newPrUrl = (repo: string, branch: string) =>
  `https://github.com/${repo}/pull/new/${branch.split('/').map(encodeURIComponent).join('/')}`

/** The `git log --format` `parseLog` reads: unit-separated fields, record-separated commits. */
export const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s%x1e'

/** Parses `git log --format=LOG_FORMAT`. */
export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map(record => record.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(record => {
      const [sha = '', short = '', author = '', when = '', refs = '', subject = ''] = record.split('\x1f').map(clean)
      return { sha, short, author, when, refs, subject }
    })
}

/**
 * Joins `--name-status -z` and `--numstat -z` of the same diff into files: a
 * status letter, the paths (a rename's old one too) and the line counts.
 */
export function parseChangedFiles(nameStatus: string, numstat: string): Omit<ChangedFile, 'target'>[] {
  const counts = parseNumstat(numstat)
  const parts = nameStatus.split('\0')
  const files: Omit<ChangedFile, 'target'>[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]
    if (!status) continue
    const letter = status[0] ?? 'M'
    // A rename or copy is followed by its old path, then its new one.
    const from = letter === 'R' || letter === 'C' ? clean(parts[++i] ?? '') : undefined
    const path = clean(parts[++i] ?? '')
    if (!path) continue
    files.push({ path, from, letter, ...counts.get(path) })
  }
  return files
}

/** The `git stash list --format` `parseStashes` reads. */
export const STASH_FORMAT = '%gd%x1f%H%x1f%ar%x1f%s'

/** Parses `git stash list --format=STASH_FORMAT`. */
export function parseStashes(out: string): Stash[] {
  return out
    .replace(/\r/g, '')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [ref = '', sha = '', when = '', message = ''] = line.split('\x1f').map(clean)
      return { ref, sha, when, message }
    })
}
