import type { Branch, Comparison, DiffEntry, FileLists, GitSnapshot, History, PullRequest, Stashes, UiState } from '../types'

// The values' initial states. Each file that reads or writes a value declares
// its own `atom(...)` with the literal reference and shape, since the
// validator lists a module's state from the atoms written in that file:
//
//   const snapshot = atom({ plugin: 'git-things', key: 'snapshot' } as const, SNAPSHOT, { shape: 'snapshot-1' })
//   const ui = atom({ plugin: 'git-things', key: 'ui' } as const, UI, { shape: 'ui-1' })
//   const diffs = atom({ plugin: 'git-things', key: 'diffs' } as const, DIFFS, { shape: 'diffs-1' })
//   const branches = atom({ plugin: 'git-things', key: 'branches' } as const, BRANCHES, { shape: 'branches-1' })
//   const pr = atom({ plugin: 'git-things', key: 'pr' } as const, PR, { shape: 'pr-1' })
//   const history = atom({ plugin: 'git-things', key: 'history' } as const, HISTORY, { shape: 'history-1' })
//   const stashes = atom({ plugin: 'git-things', key: 'stashes' } as const, STASHES, { shape: 'stashes-1' })
//   const compare = atom({ plugin: 'git-things', key: 'compare' } as const, COMPARE, { shape: 'compare-1' })
//   const fileLists = atom({ plugin: 'git-things', key: 'fileLists' } as const, FILE_LISTS, { shape: 'fileLists-1' })
//
// Change a shape tag in every file when its type's fields change: it declines
// what an earlier version stored, which outlives a reload.

export const SNAPSHOT: GitSnapshot = { entries: [], ahead: 0, behind: 0, checkedAt: 0 }
export const UI: UiState = { tab: 'changes', expanded: [], draft: '' }
export const DIFFS: Record<string, DiffEntry> = {}
export const BRANCHES: Branch[] = []
export const PR: PullRequest = { branch: '', checkedAt: 0 }
export const HISTORY: History = { commits: [], hasMore: false, loadedAt: 0 }
export const STASHES: Stashes = { list: [], loadedAt: 0 }
export const COMPARE: Comparison = { base: '', head: '', commits: [], files: [], loadedAt: 0 }
export const FILE_LISTS: FileLists = {}
