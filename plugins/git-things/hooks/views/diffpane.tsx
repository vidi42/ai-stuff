import type { EngineInterface } from 'claude-code'

import type { DiffTarget } from '../../types'
import { collapse, showDiffs, targetKey } from '../diff'
import { basename, folderOf } from '../git'
import { openFile } from '../open'
import { counts, diffBody, divider } from './shared'
import type { Ctx } from './shared'

const quiet = () => {}

/** Where a shown diff comes from, drawn dim beside its file's name. */
function source(t: DiffTarget): string {
  switch (t.kind) {
    case 'staged':
      return 'HEAD → index'
    case 'worktree':
      return 'index → working tree'
    case 'untracked':
      return 'new file'
    case 'commit':
      return t.ref?.endsWith('^3') ? `untracked in stash ${t.ref.slice(0, 7)}` : (t.ref ?? 'HEAD').slice(0, 7)
    case 'stash':
      return `stash ${(t.ref ?? '').slice(0, 7)}`
    case 'compare':
      return t.ref ?? ''
  }
}

/** One shown file: a header row like the desktop diff panel's, then its diff. */
function section($: EngineInterface, ctx: Ctx, t: DiffTarget, isOnly: boolean) {
  const { Box, Text, Button } = ctx.el
  const key = targetKey(t)
  const entry = ctx.diffs[key]
  const folder = folderOf(t.path)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          {isOnly ? (
            <Text bold>{basename(t.path)}</Text>
          ) : (
            // Shows this file on its own, with the whole pane for its diff.
            <Button key={`only:${key}`} plain onPress={() => void showDiffs($, [t], basename(t.path)).catch(quiet)}>
              {basename(t.path)}
            </Button>
          )}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-start">
            {folder ? `${folder} · ` : ''}
            {source(t)}
          </Text>
        </Box>
        <Box flexShrink={0}>{entry && entry.loadedAt !== 0 ? counts(ctx, entry.added, entry.removed) : null}</Box>
        <Button key={`pane-open:${key}`} plain dimColor onPress={() => void openFile($, t.path, ctx.openWith).catch(quiet)}>
          ↗
        </Button>
        {isOnly ? null : (
          <Button key={`hide:${key}`} plain dimColor onPress={() => void collapse($, [t]).catch(quiet)}>
            ✕
          </Button>
        )}
      </Box>
      {diffBody(ctx, t)}
    </Box>
  )
}

/** The diff pane: the files a list click or "view all" chose, stacked, each with its diff. */
export function renderDiffPane($: EngineInterface, ctx: Ctx) {
  const { Box, Text } = ctx.el
  const shown = ctx.ui.expanded
  if (shown.length === 0) {
    return <Text dimColor>Click a file in Changes, History, Stash or Compare to see its diff here.</Text>
  }
  return (
    <Box flexDirection="column" gap={1}>
      {shown.length > 1 ? (
        <Text bold>
          {ctx.ui.diffTitle ?? 'Diffs'} <Text dimColor>{shown.length}</Text>
        </Text>
      ) : null}
      {/* A line between files, as between the desktop panel's file sections. */}
      {shown.map((t, i) => (
        <Box flexDirection="column" gap={1}>
          {i > 0 ? divider(ctx) : null}
          {section($, ctx, t, shown.length === 1)}
        </Box>
      ))}
    </Box>
  )
}
