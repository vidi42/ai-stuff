import type { EngineInterface } from 'claude-code'

import { setCompare } from '../actions'
import { COMPARE_COMMITS } from '../lists'
import { commitRow, commitTitles } from './history'
import { divider, fileRow, listHeader } from './shared'
import type { Ctx } from './shared'

const quiet = () => {}

/**
 * The Compare tab: what `head` changed since it left `base`, as a pull request
 * would show it: the commits only on head, then the files with their diffs.
 */
export function renderCompare($: EngineInterface, ctx: Ctx) {
  const { Box, Text, Button, Select } = ctx.el
  const c = ctx.compare
  const names = ctx.branches.map(b => b.name)
  // A picked name that is no longer a branch still shows as picked.
  const options = (picked: string) =>
    [...new Set([...(picked && !names.includes(picked) ? [picked] : []), ...names])].map(n => ({ value: n, label: n }))

  if (!c.base || !c.head) {
    return c.loadedAt === 0 ? <Text dimColor>Comparing…</Text> : <Text color="warning">{c.error ?? 'Nothing to compare.'}</Text>
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Select
          key="compare-base"
          label="base"
          options={options(c.base)}
          value={c.base}
          onSelect={value => void setCompare($, value, c.head).catch(quiet)}
        />
        <Text dimColor>…</Text>
        <Select
          key="compare-head"
          label="compare"
          options={options(c.head)}
          value={c.head}
          onSelect={value => void setCompare($, c.base, value).catch(quiet)}
        />
        <Button key="compare-swap" plain dimColor onPress={() => void setCompare($, c.head, c.base).catch(quiet)}>
          ⇄ swap
        </Button>
      </Box>

      {c.loadedAt === 0 ? (
        <Text dimColor>Comparing…</Text>
      ) : c.error ? (
        <Text color="warning">{c.error}</Text>
      ) : c.commits.length === 0 && c.files.length === 0 ? (
        <Text dimColor>
          {c.head} has nothing that {c.base} lacks.
        </Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text bold>
              Commits <Text dimColor>{c.commits.length}{c.commits.length >= COMPARE_COMMITS ? '+' : ''}</Text>
              <Text dimColor> · on {c.head}, not on {c.base}</Text>
            </Text>
            {commitTitles(ctx)}
            {c.commits.slice(0, Math.max(ctx.maxRows, 20)).map(commit => commitRow($, ctx, commit))}
          </Box>
          {divider(ctx)}
          <Box flexDirection="column">
            {listHeader($, ctx, 'compare', 'Files', c.files.length, c.files.map(f => f.target), `${c.base} → ${c.head}`)}
            {c.files.slice(0, ctx.maxRows).map(f =>
              fileRow($, ctx, {
                target: f.target,
                letter: f.letter,
                added: f.added,
                removed: f.removed,
                canOpen: f.letter !== 'D',
              }),
            )}
            {c.files.length > ctx.maxRows ? <Text dimColor>…and {c.files.length - ctx.maxRows} more</Text> : null}
          </Box>
        </Box>
      )}
    </Box>
  )
}
