import type { Ctx } from './shared'

/** A piece of a line's text; `changed` pieces are highlighted. */
type Span = { text: string; changed: boolean }

/** One drawn line of a diff, as the desktop's diff panel lays it out. */
export type DiffRow =
  | { kind: 'hunk'; text: string }
  | {
      kind: 'context' | 'added' | 'removed'
      old?: number
      new?: number
      /** The line's text, split where it differs from the line it replaced or replaces. */
      spans: Span[]
    }

/** Splits two lines into common prefix, changed middle and common suffix. */
function wordDiff(a: string, b: string): [Span[], Span[]] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const split = (s: string) =>
    [
      { text: s.slice(0, start), changed: false },
      { text: s.slice(start, s.length - end), changed: true },
      { text: s.slice(s.length - end), changed: false },
    ].filter(p => p.text)
  // A pair with almost nothing in common reads better unhighlighted.
  if (start + end < Math.min(a.length, b.length) / 3) return [[{ text: a, changed: false }], [{ text: b, changed: false }]]
  return [split(a), split(b)]
}

/** Turns unified-diff hunks into rows with old/new line numbers and word-level changes. */
export function toRows(hunks: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  type Line = { spans: Span[] }
  let removed: Line[] = []
  let added: Line[] = []
  const pairUp = () => {
    // The i-th removed line of a change block pairs with its i-th added line.
    for (let i = 0; i < Math.min(removed.length, added.length); i++) {
      const r = removed[i]!
      const a = added[i]!
      ;[r.spans, a.spans] = wordDiff(r.spans[0]?.text ?? '', a.spans[0]?.text ?? '')
    }
    removed = []
    added = []
  }
  for (const line of hunks.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line)
    if (head) {
      pairUp()
      oldLine = Number(head[1])
      newLine = Number(head[2])
      rows.push({ kind: 'hunk', text: head[3] ?? '' })
      continue
    }
    if (line.startsWith('\\')) continue
    const text = line.slice(1)
    if (line[0] === '-') {
      if (added.length > 0) pairUp()
      const row = { kind: 'removed' as const, old: oldLine++, spans: [{ text, changed: false }] }
      removed.push(row)
      rows.push(row)
    } else if (line[0] === '+') {
      const row = { kind: 'added' as const, new: newLine++, spans: [{ text, changed: false }] }
      added.push(row)
      rows.push(row)
    } else {
      pairUp()
      rows.push({ kind: 'context', old: oldLine++, new: newLine++, spans: [{ text, changed: false }] })
    }
  }
  pairUp()
  return rows
}

const BACKGROUND = { added: 'diffAddedDimmed', removed: 'diffRemovedDimmed', context: undefined } as const
const WORD = { added: 'diffAddedWord', removed: 'diffRemovedWord', context: undefined } as const

/** What a drawn element costs against the drawing's limit: its serialized size, props included. */
export const sizeOf = (element: unknown) => JSON.stringify(element)?.length ?? 0

/**
 * Draws hunks as the desktop's diff panel does: two line-number gutters,
 * red and green line backgrounds, the changed words highlighted.
 *
 * A drawing is refused whole past 100,000 serialized characters, and a Box and
 * Text per line cost far more than the line itself. So a run of lines of one
 * kind (added, removed, unchanged) shares one Box and one Text, its lines
 * joined by line breaks, each with only its dim gutter as an element of its own.
 * Each line is charged its share against `ctx.budget.left` (and one of
 * `ctx.budget.rows`); past either, the rest are counted in a note instead.
 */
export function renderLines(ctx: Ctx, hunks: string) {
  const { Box, Text } = ctx.el
  const all = toRows(hunks)
  const width = String(
    all.reduce((n, r) => (r.kind === 'hunk' ? n : Math.max(n, r.old ?? 0, r.new ?? 0)), 1),
  ).length
  const pad = (n?: number) => (n === undefined ? '' : String(n)).padStart(width)

  type Run = { kind: 'added' | 'removed' | 'context'; pieces: unknown[] }
  const drawn: (Run | { hunk: string })[] = []
  let run: Run | undefined
  let count = 0
  for (const row of all) {
    let cost: number
    if (row.kind === 'hunk') {
      cost = row.text.length + 120
      if (ctx.budget.rows <= 0 || cost > ctx.budget.left) break
      drawn.push({ hunk: `${' '.repeat(width * 2 + 1)} ⋯ ${row.text}` })
      run = undefined
    } else {
      const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '
      const pieces: unknown[] = [
        <Text dimColor>{`${pad(row.old)} ${pad(row.new)} ${sign} `}</Text>,
        ...row.spans.map(s => (s.changed && WORD[row.kind] ? <Text backgroundColor={WORD[row.kind]}>{s.text}</Text> : s.text)),
      ]
      const isNewRun = run?.kind !== row.kind
      // A line's own pieces and its line break, plus a run's Box and Text when it opens one.
      cost = sizeOf(pieces) + 6 + (isNewRun ? 130 : 0)
      if (ctx.budget.rows <= 0 || cost > ctx.budget.left) break
      if (isNewRun || !run) {
        run = { kind: row.kind, pieces: [] }
        drawn.push(run)
      } else {
        run.pieces.push('\n')
      }
      run.pieces.push(...pieces)
    }
    ctx.budget.left -= cost
    ctx.budget.rows -= 1
    count++
  }

  return (
    <Box flexDirection="column">
      {drawn.map(d =>
        'hunk' in d ? (
          <Text mono dimColor>
            {d.hunk}
          </Text>
        ) : (
          <Box backgroundColor={BACKGROUND[d.kind]}>
            <Text mono>{d.pieces as never}</Text>
          </Box>
        ),
      )}
      {all.length > count ? (
        <Text dimColor>
          …{all.length - count} more line{all.length - count === 1 ? '' : 's'} not drawn: too much to show at once.
          Show fewer files, or open the file.
        </Text>
      ) : null}
    </Box>
  )
}
