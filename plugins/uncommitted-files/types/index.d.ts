export type Change = {
  /** Two-letter porcelain code: index then work tree, e.g. " M", "A ", "??". */
  code: string
  path: string
}

export type GitSnapshot = {
  /** The repository's top folder, or undefined outside a repo. */
  root?: string
  branch?: string
  /** e.g. "ahead 1, behind 2" */
  tracking?: string
  changes: Change[]
  error?: string
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'uncommitted-files': { snapshot: Shaped<GitSnapshot> }
  }
}
