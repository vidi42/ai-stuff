import type { EngineInterface } from 'claude-code'

import type { Branch } from '../../types'
import { createBranch, deleteBranch, setBranchDraft, switchBranch } from '../actions'
import { columnTitles, divider, shortWhen, WHEN_WIDTH } from './shared'
import type { Ctx } from './shared'

const quiet = () => {}

/**
 * Column widths, in cells, so every branch row lines up. The action columns are
 * wide enough for "check out" with the desktop's button padding, and their
 * buttons start at the column's left, so "switch" and "check out" line up.
 */
const COL = { mark: 2, track: 10, gap: 2, switch: 11, delete: 8 } as const

/** The Branches tab: create a branch, then local and remote branches with switch and delete. */
export function renderBranches($: EngineInterface, ctx: Ctx) {
  const { Box, Text, Button, Input } = ctx.el
  const locals = ctx.branches.filter(b => !b.isRemote)
  const remotes = ctx.branches.filter(b => b.isRemote)

  const cell = (width: number, content: unknown, align: 'flex-start' | 'flex-end' = 'flex-start') => (
    <Box width={width} flexShrink={0} flexDirection="row" justifyContent={align}>
      {content as never}
    </Box>
  )

  const row = (b: Branch) => {
    // origin/feature has a local twin when a local branch named feature exists.
    const local = b.isRemote ? b.name.slice(b.name.indexOf('/') + 1) : b.name
    const hasLocal = b.isRemote && locals.some(l => l.name === local)
    const track = b.isGone ? 'gone' : [b.behind ? `↓${b.behind}` : '', b.ahead ? `↑${b.ahead}` : ''].filter(Boolean).join(' ')
    return (
      // Two lines tall (name, last commit): the short columns sit on the name's line.
      <Box flexDirection="row" alignItems="flex-start">
        {cell(COL.mark, b.isCurrent ? <Text color="success">●</Text> : null)}
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="column">
          <Text bold={b.isCurrent} wrap="truncate-end">
            {b.name}
            {b.upstream ? <Text dimColor> → {b.upstream}</Text> : null}
          </Text>
          <Text dimColor wrap="truncate-end">
            {b.subject}
          </Text>
        </Box>
        {cell(COL.track, <Text color={b.isGone ? 'warning' : undefined} dimColor={!b.isGone}>{track}</Text>, 'flex-end')}
        {cell(WHEN_WIDTH, <Text dimColor>{shortWhen(b.when)}</Text>, 'flex-end')}
        {cell(COL.gap, null)}
        {cell(
          COL.switch,
          b.isCurrent ? null : (
            <Button key={`switch:${b.name}`} plain onPress={() => void switchBranch($, b, ctx.branches).catch(quiet)}>
              {b.isRemote && !hasLocal ? 'check out' : 'switch'}
            </Button>
          ),
        )}
        {cell(
          COL.delete,
          b.isRemote || b.isCurrent ? null : (
            <Button key={`delete:${b.name}`} plain dimColor onPress={() => void deleteBranch($, b).catch(quiet)}>
              delete
            </Button>
          ),
        )}
      </Box>
    )
  }

  const titles = columnTitles(ctx, [
    { title: '', width: COL.mark },
    { title: 'branch · last commit' },
    { title: 'sync', width: COL.track, align: 'right' },
    { title: 'age', width: WHEN_WIDTH, align: 'right' },
    { title: '', width: COL.gap + COL.switch + COL.delete },
  ])

  return (
    <Box flexDirection="column" gap={1}>
      <Input
        key="new-branch"
        placeholder="New branch name (Enter to create it from HEAD and switch to it)"
        value={ctx.ui.branchDraft ?? ''}
        submitLabel="Create"
        onInput={value => void setBranchDraft($, value).catch(quiet)}
        onSubmit={value => void createBranch($, value).catch(quiet)}
      />
      <Box flexDirection="column">
        <Text bold>
          Local <Text dimColor>{locals.length}</Text>
        </Text>
        {titles}
        {locals.slice(0, ctx.maxRows).map(row)}
      </Box>
      {remotes.length > 0 ? divider(ctx) : null}
      {remotes.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>
            Remote <Text dimColor>{remotes.length}</Text>
          </Text>
          {titles}
          {remotes.slice(0, ctx.maxRows).map(row)}
        </Box>
      ) : null}
    </Box>
  )
}
