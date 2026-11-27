import type { ElementTable, EngineInterface } from 'claude-code'

import type { Branch, Comparison, DiffEntry, DiffTarget, FileLists, GitSnapshot, History, PullRequest, Stashes, UiState } from '../../types'
import { clearDiffs, isExpanded, showDiffs, targetKey } from '../diff'
import { basename, describe, folderOf } from '../git'
import { openFile } from '../open'
import { renderLines } from './lines'

/**
 * Serialized characters the diff pane's lines may take. A drawing is refused
 * whole past 100,000, props included; its file headers need room too.
 */
export const DRAW_BUDGET = 88000
/** Diff lines the diff pane draws across its files; each line is a few nodes of the 20,000 a drawing may hold. */
export const DRAW_ROWS = 2500
/** Rows drawn at most per list; the pane scrolls through them. */
export const MAX_ROWS = 300

/** Column widths, in cells, so every row's counts and buttons line up. */
const COL = { symbol: 2, counts: 12, slot: 3 } as const

/**
 * `text` cut to `room` cells with an ellipsis in its middle, so both ends stay:
 * a file's extension, a folder's last part. `headShare` is how much of the
 * room the start keeps (a folder keeps more of its end: `pl…/git-things`).
 */
export function fitMiddle(text: string, room: number, headShare = 0.5): string {
  const chars = Array.from(text)
  if (chars.length <= room) return text
  if (room <= 1) return room === 1 ? '…' : ''
  const head = Math.max(1, Math.floor((room - 1) * headShare))
  const tail = room - 1 - head
  return chars.slice(0, head).join('') + '…' + (tail > 0 ? chars.slice(-tail).join('') : '')
}

/** `text` cut to `room` cells with an ellipsis at its end. */
export function fitEnd(text: string, room: number): string {
  const chars = Array.from(text)
  if (chars.length <= room) return text
  if (room <= 1) return room === 1 ? '…' : ''
  return chars.slice(0, room - 1).join('') + '…'
}

/** git's "21 minutes ago" as "21m", "4 days ago" as "4d", "3 months ago" as "3mo": a narrow, fixed column. */
export function shortWhen(when: string): string {
  const m = /^(\d+) (second|minute|hour|day|week|month|year)s?\b/.exec(when)
  if (!m) return when
  const unit = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }[m[2] as 'day']
  return `${m[1]}${unit}`
}

/** Width of a short date column: "11mo", right-aligned. */
export const WHEN_WIDTH = 5

/**
 * A thin line across the view, setting sections apart. Boxes have no one-sided
 * border, so it is a dim row of `─` as wide as the view, clipped if the surface's
 * cells run narrower than its count.
 */
export function divider(ctx: Ctx) {
  const { Box, Text } = ctx.el
  return (
    <Box overflow="hidden" flexShrink={0}>
      <Text dimColor wrap="clip">
        {'─'.repeat(Math.max(1, ctx.columns))}
      </Text>
    </Box>
  )
}

/** One column of a table's title row: fixed `width`, or none for the column that flexes. */
export type ColumnTitle = { title: string; width?: number; align?: 'left' | 'right'; marginLeft?: number }

/** Dim titles over a table's columns, each as wide as the column under it. */
export function columnTitles(ctx: Ctx, cols: readonly ColumnTitle[]) {
  const { Box, Text } = ctx.el
  return (
    <Box flexDirection="row">
      {cols.map(c =>
        c.width === undefined ? (
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Text dimColor wrap="truncate-end">
              {c.title}
            </Text>
          </Box>
        ) : (
          <Box
            width={c.width}
            flexShrink={0}
            marginLeft={c.marginLeft}
            flexDirection="row"
            justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
          >
            <Text dimColor wrap="truncate-end">
              {c.title}
            </Text>
          </Box>
        ),
      )}
    </Box>
  )
}

/** What every view draws from; `$` travels beside it, never inside an object. */
export type Ctx = {
  el: ElementTable
  /** The drawing surface: the desktop draws an Input's submit button itself. */
  surface: 'terminal' | 'desktop' | 'vscode' | 'mobile'
  snap: GitSnapshot
  ui: UiState
  diffs: Record<string, DiffEntry>
  branches: Branch[]
  pr: PullRequest
  history: History
  stashes: Stashes
  compare: Comparison
  fileLists: FileLists
  openWith: string
  model: string
  /**
   * Cells across the space this view draws in: the pane's width, less any indent
   * it sits under. Rows cut their names to it, so the fixed columns never move.
   */
  columns: number
  /** Rows drawn at most per list in this drawing: MAX_ROWS, or fewer when the drawing must shrink. */
  maxRows: number
  /** Diff characters and lines still free in this drawing; each drawn diff takes its share. */
  budget: { left: number; rows: number }
}

export type RowAction = { key: string; label: string; onPress: () => void }

export type Row = {
  target: DiffTarget
  /** A status letter (M, A, D, …, `?`); absent draws no symbol. */
  letter?: string
  added?: number
  removed?: number
  /** Draws "new" in place of counts. */
  isNew?: boolean
  canOpen: boolean
  /** One per action slot of the list, in order; `undefined` leaves its slot empty. */
  actions?: (RowAction | undefined)[]
}

const quiet = () => {}

/** "+12 −3", "+12", "−3", or "new"; zero sides left out. */
export function counts(ctx: Ctx, added?: number, removed?: number, isNew?: boolean) {
  const { Text } = ctx.el
  if (isNew) return <Text color="diffAdded">new</Text>
  if (!added && !removed) return null
  return (
    <Text tabular>
      {added ? <Text color="diffAdded">+{added}</Text> : null}
      {added && removed ? ' ' : null}
      {removed ? <Text color="diffRemoved">−{removed}</Text> : null}
    </Text>
  )
}

/** A fixed-width cell, its content centred or pushed right. */
function cell(ctx: Ctx, width: number, content: unknown, align: 'center' | 'flex-end' = 'center') {
  const { Box } = ctx.el
  return (
    <Box width={width} flexShrink={0} flexDirection="row" justifyContent={align}>
      {content as never}
    </Box>
  )
}

function actionButton(ctx: Ctx, action: RowAction | undefined) {
  const { Button } = ctx.el
  return cell(
    ctx,
    COL.slot,
    action ? (
      <Button key={action.key} plain onPress={action.onPress}>
        {action.label}
      </Button>
    ) : null,
  )
}

/**
 * A list's title row: "Changes 21 · index → working tree", a "view all" that shows
 * the list's diffs in the diff pane (or "hide all" while it does), and the list's
 * actions in the same slots as its rows' buttons.
 */
export function listHeader(
  $: EngineInterface,
  ctx: Ctx,
  id: string,
  title: string,
  count: number,
  targets: readonly DiffTarget[],
  sub?: string,
  actions: (RowAction | undefined)[] = [],
) {
  const { Box, Text, Button } = ctx.el
  const allShown = targets.length > 0 && targets.every(t => isExpanded(ctx.ui.expanded, t))
  const paneTitle = sub ? `${title} · ${sub}` : title
  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Text bold wrap="truncate-end">
          {title} <Text dimColor>{count}</Text>
          {sub ? <Text dimColor> · {sub}</Text> : null}
        </Text>
      </Box>
      {cell(
        ctx,
        COL.counts,
        targets.length > 0 ? (
          <Button
            key={`all:${id}`}
            plain
            dimColor
            onPress={() => void (allShown ? clearDiffs($) : showDiffs($, targets, paneTitle)).catch(quiet)}
          >
            {allShown ? 'hide all' : 'view all'}
          </Button>
        ) : null,
        'flex-end',
      )}
      {/* The open column has no list action. */}
      {cell(ctx, COL.slot, null)}
      {actions.map(a => actionButton(ctx, a))}
    </Box>
  )
}

/** A file's row: status, name (click: its diff in the diff pane), folder, counts, open and the list's actions. */
export function fileRow($: EngineInterface, ctx: Ctx, row: Row) {
  const { Box, Text, Button } = ctx.el
  const key = targetKey(row.target)
  // Marked while the diff pane shows it.
  const isShown = isExpanded(ctx.ui.expanded, row.target)
  const path = row.target.path
  const d = row.letter ? describe(row.letter) : undefined
  // The room left for name and folder once the fixed columns are placed: the
  // name keeps its ends (its extension), the folder its last part, then goes.
  const slots = 1 + (row.actions ?? []).length
  const room = Math.max(4, ctx.columns - COL.symbol - 1 - COL.counts - COL.slot * slots)
  const marker = isShown ? '▶ ' : ''
  const name = fitMiddle(basename(path), room - marker.length)
  const folderRoom = room - marker.length - Array.from(name).length - 1
  const folder = folderRoom >= 4 ? fitMiddle(folderOf(path), folderRoom, 0.3) : ''
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {cell(
          ctx,
          COL.symbol,
          d ? (
            <Text color={d.color} bold>
              {d.symbol}
            </Text>
          ) : null,
          'flex-end',
        )}
        {/* Only the name is a Button: a desktop draws a Button's text plain, so the
            coloured status and dim folder stay Text beside it. */}
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" gap={1} marginLeft={1}>
          <Box flexShrink={0}>
            <Button key={`diff:${key}`} plain onPress={() => void showDiffs($, [row.target], basename(path)).catch(quiet)}>
              {`${marker}${name}`}
            </Button>
          </Box>
          {folder ? (
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">
                {folder}
              </Text>
            </Box>
          ) : null}
        </Box>
        {cell(ctx, COL.counts, counts(ctx, row.added, row.removed, row.isNew), 'flex-end')}
        {cell(
          ctx,
          COL.slot,
          row.canOpen ? (
            <Button key={`open:${key}`} plain dimColor onPress={() => void openFile($, path, ctx.openWith).catch(quiet)}>
              ↗
            </Button>
          ) : null,
        )}
        {(row.actions ?? []).map(a => actionButton(ctx, a))}
      </Box>
    </Box>
  )
}

/** An open file's diff, drawn as the desktop's diff panel draws one, within the drawing's budget. */
export function diffBody(ctx: Ctx, target: DiffTarget) {
  const { Box, Text } = ctx.el
  const entry = ctx.diffs[targetKey(target)]
  if (!entry || entry.loadedAt === 0) return <Text dimColor>Loading the diff…</Text>
  if (entry.error) return <Text color="warning">{entry.error}</Text>
  if (entry.sections.length === 0) return <Text dimColor>No changes to show.</Text>
  if (ctx.budget.left < 1000 || ctx.budget.rows <= 0) {
    return <Text dimColor>Not drawn: the files above fill the pane. Show this file on its own, or open it.</Text>
  }
  return (
    <Box flexDirection="column">
      {entry.sections.map(section => (
        <Box flexDirection="column">
          {entry.sections.length > 1 ? <Text bold>{section.title}</Text> : null}
          {section.notes.map(note => (
            <Text dimColor>{note}</Text>
          ))}
          {section.hunks ? (
            renderLines(ctx, section.hunks)
          ) : section.notes.length === 0 ? (
            <Text dimColor>No text changes.</Text>
          ) : null}
        </Box>
      ))}
      {entry.omitted > 0 ? (
        <Text dimColor>…{entry.omitted} more diff lines not shown: the diff is too long. Open the file to see it all.</Text>
      ) : null}
    </Box>
  )
}
