import type { EngineInterface } from 'claude-code'

import type { Entry } from '../../types'
import { commit, discard, generate, setDraft, stage, unstage, unstageAll } from '../actions'
import { entryTarget } from '../refresh'
import { divider, fileRow, listHeader } from './shared'
import type { Ctx, RowAction } from './shared'

const quiet = () => {}

/** The Changes tab: the commit box, then Merge Changes, Staged Changes and Changes, as in VS Code. */
export function renderChanges($: EngineInterface, ctx: Ctx) {
  const { Box, Text, Button, Input } = ctx.el
  const { snap } = ctx
  const merge = snap.entries.filter(e => e.group === 'merge')
  const staged = snap.entries.filter(e => e.group === 'staged')
  const changes = snap.entries.filter(e => e.group === 'changes')
  const where = snap.branch ? `“${snap.branch}”` : 'the detached HEAD'

  const rows = (entries: Entry[], actions: (e: Entry) => (RowAction | undefined)[]) => (
    <Box flexDirection="column">
      {entries.slice(0, ctx.maxRows).map(e =>
        fileRow($, ctx, {
          target: entryTarget(e),
          letter: e.letter,
          added: e.added,
          removed: e.removed,
          isNew: e.letter === '?',
          // A deleted file is gone from the disk, so there is nothing to open.
          canOpen: !(e.group === 'changes' && e.letter === 'D') && !(e.group === 'staged' && e.letter === 'D'),
          actions: actions(e),
        }),
      )}
      {entries.length > ctx.maxRows ? <Text dimColor>…and {entries.length - ctx.maxRows} more</Text> : null}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Input
          key="commit-message"
          rows={3}
          placeholder={`Message (Enter to commit on ${where})`}
          value={ctx.ui.draft}
          submitLabel="✓ Commit"
          onInput={value => void setDraft($, value).catch(quiet)}
          onSubmit={value => void commit($, value).catch(quiet)}
        />
        <Box flexDirection="row" gap={2} marginTop={1}>
          {/* The desktop draws the field's own submit button; elsewhere it shows only while focused. */}
          {ctx.surface === 'desktop' ? null : (
            <Button key="commit" variant="primary" onPress={() => void commit($).catch(quiet)}>
              ✓ Commit
            </Button>
          )}
          {/* A quiet link, not a button that competes with Commit. */}
          <Button key="generate" plain dimColor onPress={() => void generate($, ctx.model).catch(quiet)}>
            ✨ Generate message
          </Button>
        </Box>
      </Box>

      {divider(ctx)}

      {snap.entries.length === 0 ? <Text color="success">Working tree clean. Nothing to commit.</Text> : null}

      {merge.length > 0 ? (
        <Box flexDirection="column">
          {listHeader($, ctx, 'merge', 'Merge Changes', merge.length, merge.map(entryTarget), 'conflicts', [
            undefined,
            { key: 'stage-all:merge', label: '+', onPress: () => void stage($, merge).catch(quiet) },
          ])}
          {rows(merge, e => [undefined, { key: `stage:merge:${e.path}`, label: '+', onPress: () => void stage($, [e]).catch(quiet) }])}
        </Box>
      ) : null}

      {staged.length > 0 ? (
        <Box flexDirection="column">
          {listHeader($, ctx, 'staged', 'Staged Changes', staged.length, staged.map(entryTarget), 'HEAD → index', [
            undefined,
            { key: 'unstage-all', label: '−', onPress: () => void unstageAll($).catch(quiet) },
          ])}
          {rows(staged, e => [undefined, { key: `unstage:${e.path}`, label: '−', onPress: () => void unstage($, [e]).catch(quiet) }])}
        </Box>
      ) : null}

      {changes.length > 0 ? (
        <Box flexDirection="column">
          {listHeader($, ctx, 'changes', 'Changes', changes.length, changes.map(entryTarget), 'index → working tree', [
            { key: 'discard-all', label: '↺', onPress: () => void discard($, changes).catch(quiet) },
            { key: 'stage-all', label: '+', onPress: () => void stage($, changes).catch(quiet) },
          ])}
          {rows(changes, e => [
            { key: `discard:${e.path}`, label: '↺', onPress: () => void discard($, [e]).catch(quiet) },
            { key: `stage:${e.path}`, label: '+', onPress: () => void stage($, [e]).catch(quiet) },
          ])}
        </Box>
      ) : null}
    </Box>
  )
}
