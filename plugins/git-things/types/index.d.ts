/** Which list of the Changes tab an entry belongs to, as VS Code groups them. */
export type Group = 'merge' | 'staged' | 'changes'

/** One file in one group: a file staged and changed again shows in two groups. */
export type Entry = {
  group: Group
  /**
   * Its git status letter for that group: the index side (X) for `staged`,
   * the work tree side (Y) for `changes`, `?` when untracked, `U` in `merge`.
   */
  letter: string
  /** Relative to the repository's top folder. */
  path: string
  /** A staged rename's old path. */
  from?: string
  /** Lines added and removed for this group's side; absent for untracked or binary files. */
  added?: number
  removed?: number
}

export type GitSnapshot = {
  /** The session's folder, where git was run. */
  root?: string
  /** The repository's top folder, which every path is relative to. */
  top?: string
  /** The current branch; undefined when HEAD is detached. */
  branch?: string
  /** HEAD's short commit id; undefined before the first commit. */
  oid?: string
  /** No commit yet: there is no HEAD to diff or reset against. */
  isInitial?: boolean
  upstream?: string
  ahead: number
  behind: number
  entries: Entry[]
  error?: string
  checkedAt: number
}

export type Tab = 'changes' | 'branches' | 'history' | 'stash' | 'compare'

/** What a diff is between, for one file. */
export type DiffTarget = {
  /**
   * `staged` HEAD → index, `worktree` index → work tree, `untracked` a new
   * file, `commit` one commit, `stash` one stash, `compare` `base...head`.
   */
  kind: 'staged' | 'worktree' | 'untracked' | 'commit' | 'stash' | 'compare'
  path: string
  from?: string
  /** The commit, the stash, or the `base...head` range. */
  ref?: string
}

/** One file's part of a diff: what git said about it, then its hunks. */
export type DiffSection = {
  title: string
  /** Header lines worth showing: new file, deleted, mode, rename, binary. */
  notes: string[]
  /** Unified-diff hunks, ready for `<Code format="diff">`; empty for none. */
  hunks: string
}

export type DiffEntry = {
  sections: DiffSection[]
  added: number
  removed: number
  /** Diff lines left out because the diff was too long. */
  omitted: number
  /** Characters the hunks take when drawn. */
  size: number
  error?: string
  /** 0 while loading. */
  loadedAt: number
}

export type UiState = {
  tab: Tab
  /** The files the diff pane shows, in order. */
  expanded: DiffTarget[]
  /** What the diff pane shows: a file's name, or a list's title. */
  diffTitle?: string
  /** The commit message being written. */
  draft: string
  /** The new branch name being written. */
  branchDraft?: string
  /** The stash message being written. */
  stashDraft?: string
  /** The commit whose files show under it, in History or Compare (its full sha). */
  openCommit?: string
  /** The stash whose files show under it, by its commit sha. */
  openStash?: string
  /** What Compare compares: base...head, each a branch name. */
  compareBase?: string
  compareHead?: string
  /** Commits History lists; grows with Load more. */
  historyLimit?: number
  /** What runs now ("Committing…"); one action at a time. */
  busy?: string
  /** The last action's failure, until the next action or a dismiss. */
  error?: string
}

export type Branch = {
  /** `main`, or `origin/main` for a remote branch. */
  name: string
  isRemote: boolean
  isCurrent: boolean
  /** A local branch's upstream, e.g. `origin/main`. */
  upstream?: string
  ahead: number
  behind: number
  /** The upstream is gone from the remote. */
  isGone: boolean
  /** When its last commit was made, e.g. "3 days ago". */
  when: string
  subject: string
}

/** The current branch's pull request, or where to create one. */
export type PullRequest = {
  /** The branch this was looked up for. */
  branch: string
  number?: number
  url?: string
  /** OPEN, CLOSED or MERGED. */
  state?: string
  isDraft?: boolean
  title?: string
  /** Where to open a new one, when there is none and the remote is on GitHub. */
  createUrl?: string
  checkedAt: number
}

export type Commit = {
  sha: string
  short: string
  author: string
  /** When it was made, e.g. "3 days ago". */
  when: string
  /** Branches and tags pointing at it, e.g. "HEAD -> main, origin/main". */
  refs: string
  subject: string
}

/** A file a commit, a stash or a comparison changed. */
export type ChangedFile = {
  path: string
  from?: string
  /** M, A, D, R, C or T. */
  letter: string
  added?: number
  removed?: number
  /** The diff target that shows it. */
  target: DiffTarget
}

export type History = {
  commits: Commit[]
  /** More commits exist past the ones listed. */
  hasMore: boolean
  error?: string
  loadedAt: number
}

export type Stash = {
  /** `stash@{0}`: where it sits now, which shifts as stashes are added and dropped. */
  ref: string
  /** Its commit, which does not shift: what opens it and keys its files. */
  sha: string
  /** "On main: wip". */
  message: string
  when: string
}

export type Stashes = { list: Stash[]; error?: string; loadedAt: number }

export type Comparison = {
  base: string
  head: string
  /** Commits on head and not on base, newest first. */
  commits: Commit[]
  /** Files changed on head since it left base (`base...head`). */
  files: ChangedFile[]
  error?: string
  loadedAt: number
}

/** The files of an opened commit or stash, keyed `commit|<sha>` or `stash|<sha>`. */
export type FileLists = Record<string, { files: ChangedFile[]; error?: string; loadedAt: number }>

declare module 'claude-code' {
  interface PluginState {
    'git-things': {
      snapshot: Shaped<GitSnapshot>
      ui: Shaped<UiState>
      /** Loaded diffs, keyed by `targetKey(target)`. */
      diffs: Shaped<Record<string, DiffEntry>>
      branches: Shaped<Branch[]>
      pr: Shaped<PullRequest>
      history: Shaped<History>
      stashes: Shaped<Stashes>
      compare: Shaped<Comparison>
      fileLists: Shaped<FileLists>
    }
  }
}
