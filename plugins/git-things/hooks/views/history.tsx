import type { EngineInterface } from 'claude-code'

import type { ChangedFile, Commit } from '../../types'
import { loadMoreHistory, toggleCommit } from '../actions'
import { columnTitles, fileRow, fitEnd, listHeader, shortWhen, WHEN_WIDTH } from './shared'
import type { Ctx } from './shared'

const quiet = () => {}

/** Column widths, in cells, so commit rows line up. */
const COL = { sha: 9, author: 12 } as const

/**
 * The files of an opened commit or stash, under its row: a list header with
 * view all, then each file, whose diff a click shows in the diff pane.
 */
export function fileListUnder($: EngineInterface, ctx: Ctx, key: string, title: string, sub?: string) {
  const { Box, Text } = ctx.el
  const list = ctx.fileLists[key]
  if (!list) return <Text dimColor>Loading the files…</Text>
  if (list.error) return <Text color="warning">{list.error}</Text>
  if (list.files.length === 0) return <Text dimColor>No file changes.</Text>
  const files = list.files.slice(0, ctx.maxRows)
  return (
    <Box flexDirection="column">
      {listHeader($, ctx, key, title, list.files.length, files.map(f => f.target), sub)}
      {files.map((f: ChangedFile) =>
        fileRow($, ctx, {
          target: f.target,
          letter: f.letter,
          added: f.added,
          removed: f.removed,
          isNew: f.letter === 'A' && f.added === undefined,
          // Opens the file as it is now in the working tree.
          canOpen: f.letter !== 'D',
        }),
      )}
      {list.files.length > files.length ? <Text dimColor>…and {list.files.length - files.length} more</Text> : null}
    </Box>
  )
}

/** Titles over commit rows, column for column. */
export function commitTitles(ctx: Ctx) {
  return columnTitles(ctx, [
    { title: 'commit', width: COL.sha },
    { title: 'message' },
    { title: 'author', width: COL.author, marginLeft: 1 },
    { title: 'age', width: WHEN_WIDTH, align: 'right' },
  ])
}

/** One commit: short sha, subject (click for its files), refs, author, when. */
export function commitRow($: EngineInterface, ctx: Ctx, c: Commit) {
  const { Box, Text, Button } = ctx.el
  const isOpen = ctx.ui.openCommit === c.sha
  const cell = (width: number, content: unknown) => (
    <Box width={width} flexShrink={0} flexDirection="row" justifyContent="flex-end">
      {content as never}
    </Box>
  )
  // The subject takes what the fixed columns leave, cut at its end; the refs
  // follow it while room is left.
  const room = Math.max(8, ctx.columns - COL.sha - COL.author - WHEN_WIDTH - 2)
  const subject = fitEnd(`${isOpen ? '▾' : '▸'} ${c.subject}`, room)
  const refsRoom = room - Array.from(subject).length - 1
  const refs = refsRoom >= 6 ? fitEnd(c.refs.replace(/^HEAD -> /, ''), refsRoom) : ''
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={COL.sha} flexShrink={0}>
          <Text mono dimColor>
            {c.short}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" gap={1}>
          <Box flexShrink={0}>
            <Button key={`commit:${c.sha}`} plain onPress={() => void toggleCommit($, c.sha).catch(quiet)}>
              {subject}
            </Button>
          </Box>
          {refs ? (
            <Box flexShrink={1} minWidth={0}>
              <Text color="suggestion" wrap="truncate-end">
                {refs}
              </Text>
            </Box>
          ) : null}
        </Box>
        <Box width={COL.author} flexShrink={0} marginLeft={1} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {c.author}
          </Text>
        </Box>
        {cell(WHEN_WIDTH, <Text dimColor>{shortWhen(c.when)}</Text>)}
      </Box>
      {isOpen ? (
        <Box flexDirection="column" marginLeft={COL.sha} marginTop={1} marginBottom={1}>
          {fileListUnder($, { ...ctx, columns: ctx.columns - COL.sha }, `commit|${c.sha}`, 'Files', c.short)}
        </Box>
      ) : null}
    </Box>
  )
}

/** The History tab: the branch's latest commits, newest first, with Load more. */
export function renderHistory($: EngineInterface, ctx: Ctx) {
  const { Box, Text, Button } = ctx.el
  // Not `h`: JSX compiles to calls of the global `h`.
  const log = ctx.history
  if (log.loadedAt === 0) return <Text dimColor>Loading the history…</Text>
  if (log.error) return <Text color="warning">{log.error}</Text>
  if (log.commits.length === 0) return <Text dimColor>No commits yet.</Text>
  return (
    <Box flexDirection="column">
      <Text bold>
        History <Text dimColor>{log.commits.length}{log.hasMore ? '+' : ''}</Text>
        <Text dimColor> · {ctx.snap.branch ?? 'HEAD'}</Text>
      </Text>
      {commitTitles(ctx)}
      {log.commits.slice(0, Math.max(ctx.maxRows, 20)).map(c => commitRow($, ctx, c))}
      {log.hasMore ? (
        <Box marginTop={1}>
          <Button key="history-more" plain dimColor onPress={() => void loadMoreHistory($).catch(quiet)}>
            Load more
          </Button>
        </Box>
      ) : null}
    </Box>
  )
}
