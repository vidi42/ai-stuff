import type { EngineInterface } from 'claude-code'

import type { Stash } from '../../types'
import { setStashDraft, stashApply, stashDrop, stashPop, stashPush, toggleStash } from '../actions'
import { fileListUnder } from './history'
import { columnTitles, divider, fitEnd, shortWhen, WHEN_WIDTH } from './shared'
import type { Ctx } from './shared'

const quiet = () => {}

/** Column widths, in cells, so stash rows line up. */
const COL = { ref: 11, action: 7 } as const

/** The Stash tab: stash every change, then each stash with apply, pop and drop. */
export function renderStash($: EngineInterface, ctx: Ctx) {
  const { Box, Text, Button, Input } = ctx.el
  const s = ctx.stashes
  const changed = new Set(ctx.snap.entries.map(e => e.path)).size

  const cell = (width: number, content: unknown) => (
    <Box width={width} flexShrink={0} flexDirection="row" justifyContent="flex-end">
      {content as never}
    </Box>
  )

  const row = (stash: Stash) => {
    const isOpen = ctx.ui.openStash === stash.sha
    const message = fitEnd(`${isOpen ? '▾' : '▸'} ${stash.message}`, Math.max(8, ctx.columns - COL.ref - WHEN_WIDTH - COL.action * 3))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box width={COL.ref} flexShrink={0}>
            <Text mono dimColor>
              {stash.ref}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Button key={`stash:${stash.sha}`} plain onPress={() => void toggleStash($, stash.sha).catch(quiet)}>
              {message}
            </Button>
          </Box>
          {cell(WHEN_WIDTH, <Text dimColor>{shortWhen(stash.when)}</Text>)}
          {cell(
            COL.action,
            <Button key={`apply:${stash.sha}`} plain onPress={() => void stashApply($, stash).catch(quiet)}>
              apply
            </Button>,
          )}
          {cell(
            COL.action,
            <Button key={`pop:${stash.sha}`} plain onPress={() => void stashPop($, stash).catch(quiet)}>
              pop
            </Button>,
          )}
          {cell(
            COL.action,
            <Button key={`drop:${stash.sha}`} plain dimColor onPress={() => void stashDrop($, stash).catch(quiet)}>
              drop
            </Button>,
          )}
        </Box>
        {isOpen ? (
          <Box flexDirection="column" marginLeft={COL.ref} marginTop={1} marginBottom={1}>
            {fileListUnder($, { ...ctx, columns: ctx.columns - COL.ref }, `stash|${stash.sha}`, 'Files', stash.ref)}
          </Box>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Input
          key="stash-message"
          placeholder={changed ? `Message for a stash of ${changed} changed file${changed === 1 ? '' : 's'} (optional, Enter to stash)` : 'Nothing to stash'}
          value={ctx.ui.stashDraft ?? ''}
          submitLabel="Stash"
          onInput={value => void setStashDraft($, value).catch(quiet)}
          onSubmit={value => void stashPush($, value).catch(quiet)}
        />
        {/* The desktop draws the field's own submit button; elsewhere it shows only while focused. */}
        {ctx.surface === 'desktop' ? null : (
          <Box marginTop={1}>
            <Button key="stash-push" plain onPress={() => void stashPush($, ctx.ui.stashDraft ?? '').catch(quiet)}>
              Stash changes
            </Button>
          </Box>
        )}
      </Box>
      {divider(ctx)}
      {s.loadedAt === 0 ? (
        <Text dimColor>Loading the stashes…</Text>
      ) : s.error ? (
        <Text color="warning">{s.error}</Text>
      ) : s.list.length === 0 ? (
        <Text dimColor>No stashes.</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>
            Stashes <Text dimColor>{s.list.length}</Text>
          </Text>
          {columnTitles(ctx, [
            { title: 'stash', width: COL.ref },
            { title: 'message' },
            { title: 'age', width: WHEN_WIDTH, align: 'right' },
            { title: '', width: COL.action * 3 },
          ])}
          {s.list.slice(0, ctx.maxRows).map(row)}
        </Box>
      )}
    </Box>
  )
}
