import type { EngineInterface } from 'claude-code'

import type { Tab } from '../../types'
import { dismissError, fetchAll, pull, push, setTab, switchBranch } from '../actions'
import { refresh } from '../refresh'
import { divider } from './shared'
import type { Ctx } from './shared'

const quiet = () => {}

/** The tabs, in order. */
const TABS: { tab: Tab; label: string }[] = [
  { tab: 'changes', label: 'Changes' },
  { tab: 'branches', label: 'Branches' },
  { tab: 'history', label: 'History' },
  { tab: 'stash', label: 'Stash' },
  { tab: 'compare', label: 'Compare' },
]

const PR_COLOR = { OPEN: 'success', MERGED: 'merged', CLOSED: 'error' } as const

/**
 * The pane's top: the branch picker with ahead/behind, Fetch / Pull / Push,
 * the branch's pull request, the last error, then the tab row.
 */
export function renderHeader($: EngineInterface, ctx: Ctx) {
  const { Box, Text, Button, Select, Link } = ctx.el
  const { snap, ui, pr } = ctx
  const locals = ctx.branches.filter(b => !b.isRemote)
  const options = locals.map(b => ({ value: b.name, label: b.name }))
  if (!snap.branch) options.unshift({ value: '', label: snap.oid ? `detached at ${snap.oid}` : 'no branch' })
  const hasPr = pr.branch === snap.branch && (pr.url || pr.createUrl)

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        {/* Shrinks and clips first, so the sync buttons always keep their place. */}
        <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Select
            key="branch"
            label="⎇"
            options={options}
            value={snap.branch ?? ''}
            onSelect={value => {
              const branch = locals.find(b => b.name === value)
              if (branch) void switchBranch($, branch, ctx.branches).catch(quiet)
            }}
          />
          {snap.upstream ? (
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">
                → {snap.upstream}
                {snap.behind ? ` ↓${snap.behind}` : ''}
                {snap.ahead ? ` ↑${snap.ahead}` : ''}
              </Text>
            </Box>
          ) : snap.branch ? (
            <Text dimColor>not published</Text>
          ) : null}
        </Box>
        <Box flexDirection="row" gap={2} flexShrink={0}>
          {ui.busy ? <Text dimColor>{ui.busy}</Text> : null}
          <Button key="fetch" plain onPress={() => void fetchAll($).catch(quiet)}>
            ⟳ Fetch
          </Button>
          <Button key="pull" plain onPress={() => void pull($).catch(quiet)}>
            {snap.behind ? `↓ Pull ${snap.behind}` : '↓ Pull'}
          </Button>
          <Button key="push" plain onPress={() => void push($).catch(quiet)}>
            {snap.upstream ? (snap.ahead ? `↑ Push ${snap.ahead}` : '↑ Push') : '↑ Publish'}
          </Button>
          <Button key="refresh" plain dimColor onPress={() => void refresh($).catch(quiet)}>
            ↻
          </Button>
        </Box>
      </Box>

      {hasPr ? (
        pr.url ? (
          <Text wrap="truncate-end">
            <Text color={pr.isDraft ? 'subtle' : PR_COLOR[pr.state as keyof typeof PR_COLOR] ?? 'text'}>
              {pr.isDraft ? 'Draft' : (pr.state ?? '').toLowerCase()}
            </Text>{' '}
            <Link href={pr.url}>{`PR #${pr.number} ${pr.title ?? ''} ↗`}</Link>
          </Text>
        ) : (
          <Link href={pr.createUrl ?? ''}>Create pull request ↗</Link>
        )
      ) : null}

      {ui.error ? (
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="error">{ui.error}</Text>
          <Button key="dismiss-error" plain dimColor onPress={() => void dismissError($).catch(quiet)}>
            ✕
          </Button>
        </Box>
      ) : null}
      </Box>
      {/* The bar (branch, sync, pull request) apart from the tabs, and the tabs from the view. */}
      {divider(ctx)}
      <Box flexDirection="row" gap={1}>
        {TABS.map(t => (
          <Button
            key={`tab:${t.tab}`}
            plain={ui.tab === t.tab ? undefined : true}
            variant={ui.tab === t.tab ? 'primary' : undefined}
            dimColor={ui.tab !== t.tab}
            onPress={() => void setTab($, t.tab).catch(quiet)}
          >
            {t.label}
          </Button>
        ))}
      </Box>
      {divider(ctx)}
    </Box>
  )
}
