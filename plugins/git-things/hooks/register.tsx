import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { clearDiffs } from './diff'
import { refresh } from './refresh'
import { BRANCHES, COMPARE, DIFFS, FILE_LISTS, HISTORY, PR, SNAPSHOT, STASHES, UI } from './state'
import { renderBranches } from './views/branches'
import { renderChanges } from './views/changes'
import { renderCompare } from './views/compare'
import { renderDiffPane } from './views/diffpane'
import { renderHeader } from './views/header'
import { renderHistory } from './views/history'
import { sizeOf } from './views/lines'
import { DRAW_BUDGET, DRAW_ROWS, MAX_ROWS } from './views/shared'
import type { Ctx } from './views/shared'
import { renderStash } from './views/stash'

const snapshot = atom({ plugin: 'git-things', key: 'snapshot' } as const, SNAPSHOT, { shape: 'snapshot-1' })
const ui = atom({ plugin: 'git-things', key: 'ui' } as const, UI, { shape: 'ui-1' })
const diffs = atom({ plugin: 'git-things', key: 'diffs' } as const, DIFFS, { shape: 'diffs-1' })
const branches = atom({ plugin: 'git-things', key: 'branches' } as const, BRANCHES, { shape: 'branches-1' })
const pr = atom({ plugin: 'git-things', key: 'pr' } as const, PR, { shape: 'pr-1' })
const history = atom({ plugin: 'git-things', key: 'history' } as const, HISTORY, { shape: 'history-1' })
const stashes = atom({ plugin: 'git-things', key: 'stashes' } as const, STASHES, { shape: 'stashes-1' })
const compare = atom({ plugin: 'git-things', key: 'compare' } as const, COMPARE, { shape: 'compare-1' })
const fileLists = atom({ plugin: 'git-things', key: 'fileLists' } as const, FILE_LISTS, { shape: 'fileLists-1' })

const PANE = 'git-things'
const TITLE = 'git-things'
const COMMAND = 'git-things'
const POLL_MS = 5000

/** Under the 100,000 serialized characters a drawing may hold, with room to spare. */
const DRAW_LIMIT = 95000
/** Rows per list to try in the main pane, in order, until the drawing fits. */
const ROW_FALLBACKS = [MAX_ROWS, 120, 60, 20]
/** Diff characters to try in the diff pane, in order, until the drawing fits. */
const DIFF_FALLBACKS = [DRAW_BUDGET, 40000, 15000, 0]

const quiet = () => {}

/** Reads everything a view draws from, for one drawing of the given limits. */
async function readCtx($: EngineInterface, el: Ctx['el'], surface: Ctx['surface'], columns: number, openWith: string, model: string) {
  // Never name anything `h`: JSX compiles to calls of the global `h`.
  const [snap, u, d, b, p, hist, st, cmp, fl] = await Promise.all([
    read($, snapshot),
    read($, ui),
    read($, diffs),
    read($, branches),
    read($, pr),
    read($, history),
    read($, stashes),
    read($, compare),
    read($, fileLists),
  ])
  return (diffChars: number, maxRows: number): Ctx => ({
    el,
    surface,
    columns,
    snap,
    ui: u,
    diffs: d,
    branches: b,
    pr: p,
    history: hist,
    stashes: st,
    compare: cmp,
    fileLists: fl,
    openWith,
    model,
    maxRows,
    budget: { left: diffChars, rows: DRAW_ROWS },
  })
}

export const register: Register = (on, options) => {
  const openWith = typeof options.openWith === 'string' ? options.openWith : ''
  const model = typeof options.generateModel === 'string' && options.generateModel.trim() ? options.generateModel.trim() : 'haiku'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open the git-things pane: changes, branches, history, stash, compare and sync',
    })
    // The pane opens only on /git-things; the status line keeps count meanwhile.
    refresh($).catch(quiet)
    // Catches edits made outside Claude (your editor, a terminal).
    $.clock.every(POLL_MS, () => refresh($).catch(quiet))

    return next(e)
  })

  on('command.run', { command: 'git-things' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    const { entries, error } = await read($, snapshot)
    const count = new Set(entries.map(e => e.path)).size

    return { text: error ?? `${count} changed file(s). git-things pane opened.` }
  })

  // Re-check right after Claude edits a file or runs a command.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(e.tool)) refresh($).catch(quiet)

    return ran
  })

  // Closing the diff pane forgets what it showed, so its diffs stop reloading.
  on('ui.close', { id: 'git-things-diff' }, async ($, e, next) => {
    await clearDiffs($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const ctxFor = await readCtx($, el, e.surface, e.props.bodyColumns, openWith, model)
    const { snap, ui: u } = ctxFor(0, MAX_ROWS)

    if (snap.error || snap.checkedAt === 0) {
      return (
        <Box flexDirection="row" justifyContent="space-between">
          {snap.error ? <Text color="warning">{snap.error}</Text> : <Text dimColor>Checking…</Text>}
          <Button key="refresh" plain dimColor onPress={() => void refresh($).catch(quiet)}>
            Refresh
          </Button>
        </Box>
      )
    }
    const draw = (maxRows: number) => {
      // Diffs draw in the diff pane, so the lists take no diff budget here.
      const ctx = ctxFor(0, maxRows)
      return (
        <Box flexDirection="column" gap={1}>
          {renderHeader($, ctx)}
          {u.tab === 'branches'
            ? renderBranches($, ctx)
            : u.tab === 'history'
              ? renderHistory($, ctx)
              : u.tab === 'stash'
                ? renderStash($, ctx)
                : u.tab === 'compare'
                  ? renderCompare($, ctx)
                  : renderChanges($, ctx)}
        </Box>
      )
    }

    // A drawing past 100,000 serialized characters is refused whole and the pane
    // goes blank: measure, and step down to fewer rows until it fits.
    for (const maxRows of ROW_FALLBACKS) {
      const tree = draw(maxRows)
      if (sizeOf(tree) <= DRAW_LIMIT) return tree
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="warning">Too many changes to draw here. Use a terminal or your editor's git view.</Text>
        <Button key="refresh" plain dimColor onPress={() => void refresh($).catch(quiet)}>
          Refresh
        </Button>
      </Box>
    )
  })

  // The diff pane: a drawing of its own, so a diff has nearly all of the limit.
  on('ui.render', { component: 'Pane', requestId: 'git-things-diff' }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Text } = el
    const ctxFor = await readCtx($, el, e.surface, e.props.bodyColumns, openWith, model)
    for (const diffChars of DIFF_FALLBACKS) {
      const tree = renderDiffPane($, ctxFor(diffChars, MAX_ROWS))
      if (sizeOf(tree) <= DRAW_LIMIT) return tree
    }
    return <Text color="warning">Too much to draw here. Show fewer files, or open them.</Text>
  })
}
