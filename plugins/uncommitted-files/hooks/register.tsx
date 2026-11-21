import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Change, GitSnapshot } from '../types'

const PANE = 'uncommitted-files'
const TITLE = 'Uncommitted files'
const POLL_MS = 5000

// Change the tag when GitSnapshot's fields change: it declines what an
// earlier version stored, which outlives a reload.
const snapshot = atom(
  { plugin: 'uncommitted-files', key: 'snapshot' } as const,
  { changes: [], checkedAt: 0 } as GitSnapshot,
  { shape: 'snapshot-1' },
)

/** Parses `git status --porcelain=v1 --branch -z`. */
function parse(out: string): Pick<GitSnapshot, 'branch' | 'tracking' | 'changes'> {
  const parts = out.split('\0')
  const changes: Change[] = []
  let branch: string | undefined
  let tracking: string | undefined
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    if (entry.startsWith('## ')) {
      const head = entry.slice(3)
      const m = /^(.*?)(?:\.\.\.\S+)?(?: \[(.+)\])?$/.exec(head)
      branch = (m?.[1] ?? head).replace(/^No commits yet on /, '')
      tracking = m?.[2]
      continue
    }
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    // A rename or copy carries its old path as the next NUL-separated entry.
    if (code[0] === 'R' || code[0] === 'C') i++
    changes.push({ code, path })
  }
  return { branch, tracking, changes }
}

function describe(code: string): { label: string; color: Color; where: string } {
  const [x, y] = [code[0], code[1]]
  if (code === '??') return { label: 'untracked', color: 'subtle', where: '' }
  const conflict = x === 'U' || y === 'U' || code === 'AA' || code === 'DD'
  const letter = conflict ? 'U' : x !== ' ' ? x : y
  const where =
    conflict ? '' : x !== ' ' && y !== ' ' ? 'staged + unstaged' : x !== ' ' ? 'staged' : ''
  switch (letter) {
    case 'U': return { label: 'conflict', color: 'error', where }
    case 'A': return { label: 'added', color: 'success', where }
    case 'D': return { label: 'deleted', color: 'diffRemoved', where }
    case 'R': return { label: 'renamed', color: 'suggestion', where }
    case 'C': return { label: 'copied', color: 'suggestion', where }
    case 'T': return { label: 'type changed', color: 'warning', where }
    default: return { label: 'modified', color: 'warning', where }
  }
}

let inFlight = false

async function refresh($: EngineInterface): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const root = await $.session.cwd()
    let next: GitSnapshot
    try {
      const { exitCode, stdout, stderr } = await $.process.run(
        ['git', 'status', '--porcelain=v1', '--branch', '-z'],
        { cwd: root, timeoutMs: 15000 },
      )
      next =
        exitCode === 0
          ? { root, ...parse(stdout), checkedAt: Date.now() }
          : {
              root,
              changes: [],
              error: /not a git repository/i.test(stderr)
                ? 'This folder is not a git repository.'
                : stderr.trim() || `git exited with ${exitCode}`,
              checkedAt: Date.now(),
            }
    } catch (err) {
      next = { root, changes: [], error: `Could not run git: ${String(err)}`, checkedAt: Date.now() }
    }
    await update($, snapshot, prev => {
      const same =
        prev.root === next.root &&
        prev.branch === next.branch &&
        prev.tracking === next.tracking &&
        prev.error === next.error &&
        JSON.stringify(prev.changes) === JSON.stringify(next.changes)
      // Keep the old value when nothing changed, so the pane does not redraw every poll.
      return same ? prev : next
    })
    const count = next.changes.length
    $.ui.status(next.error ? undefined : count === 0 ? '✓ clean' : `● ${count} uncommitted`)
  } finally {
    inFlight = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'uncommitted',
      description: 'Show the uncommitted files of this project in a side pane',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    refresh($).catch(() => {})
    // Catches edits made outside Claude (your editor, a terminal).
    $.clock.every(POLL_MS, () => refresh($).catch(() => {}))

    return next(e)
  })

  on('command.run', { command: 'uncommitted' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    const { changes, error } = await read($, snapshot)

    return { text: error ?? `${changes.length} uncommitted file(s). Pane opened.` }
  })

  // Re-check right after Claude edits a file or runs a command.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(e.tool)) refresh($).catch(() => {})

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const shown = snap.changes.slice(0, room)
    const hidden = snap.changes.length - shown.length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            {snap.branch ? `⎇ ${snap.branch}` : 'git'}
            {snap.tracking ? <Text dimColor> [{snap.tracking}]</Text> : null}
          </Text>
          <Button onPress={() => refresh($).catch(() => {})}>Refresh</Button>
        </Box>
        {snap.error ? (
          <Text color="warning">{snap.error}</Text>
        ) : snap.checkedAt === 0 ? (
          <Text dimColor>Checking…</Text>
        ) : snap.changes.length === 0 ? (
          <Text color="success">Working tree clean. Nothing to commit.</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              {snap.changes.length} uncommitted file{snap.changes.length === 1 ? '' : 's'}
            </Text>
            {shown.map(change => {
              const d = describe(change.code)
              return (
                <Text key={change.path}>
                  <Text color={d.color}>{d.label.padEnd(10)}</Text> {change.path}
                  {d.where ? <Text dimColor> ({d.where})</Text> : null}
                </Text>
              )
            })}
            {hidden > 0 ? <Text dimColor>…and {hidden} more</Text> : null}
          </Box>
        )}
      </Box>
    )
  })
}
