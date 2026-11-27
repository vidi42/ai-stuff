import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseChangedFiles, parseLog, parseStashes } from '../hooks/git'
import { defaultBase } from '../hooks/lists'
import { fitEnd, fitMiddle, shortWhen } from '../hooks/views/shared'

// Formats as git 2.56 prints them, captured from a real repository.
const SHA1 = '454312d3f12b5ebb1898a89d719d889287f30877'
const SHA2 = 'ae4a6747b5bf7458a41ee49570aa2838f522f07a'
const STASH_SHA = 'c0ffee0000000000000000000000000000000001'
const LOG =
  `${SHA1}\x1f454312d\x1fAlex\x1f19 hours ago\x1fHEAD -> feature, origin/feature\x1fTidy both\x1e\n` +
  `${SHA2}\x1fae4a674\x1fAlex\x1f20 hours ago\x1f\x1finit\x1e\n`
const STATUS = ['# branch.oid ' + SHA1, '# branch.head feature', '1 .M N... 100644 100644 100644 a b keep.txt', ''].join('\0')
const BRANCHES = [
  ['refs/heads/feature', 'feature', '', '', '*', '19 hours ago', 'Tidy both'],
  ['refs/heads/main', 'main', 'origin/main', '', ' ', '20 hours ago', 'init'],
  ['refs/remotes/origin/main', 'origin/main', '', '', ' ', '20 hours ago', 'init'],
]
  .map(f => f.join('\0'))
  .join('\n')
const DIFF = ['diff --git a/both.txt b/both.txt', '--- a/both.txt', '+++ b/both.txt', '@@ -1 +1 @@', '-m', '+m2', ''].join('\n')

const PANE = {
  plugin: 'git-things',
  component: 'Pane',
  requestId: 'git-things',
  props: { title: 'git-things', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

/** Stands in for git in /repo; answers questions with `answer`; records every git argv. */
function fakeGit(on: On, answer = 'Cancel') {
  const runs: string[][] = []
  const asked: string[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const reply = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } as never })
    if (e.argv[0] === 'gh') return reply('', 1)
    const argv = e.argv[1] === '-c' ? e.argv.slice(3) : e.argv.slice(1)
    runs.push(argv)
    const has = (...words: string[]) => words.every(w => argv.includes(w))
    if (argv[0] === 'status') return reply(STATUS)
    if (argv[0] === 'rev-parse') return reply('/repo\n')
    if (argv[0] === 'for-each-ref') return reply(BRANCHES)
    if (argv[0] === 'remote' || argv[0] === 'symbolic-ref') return reply('', 1)
    if (argv[0] === 'log') return reply(LOG)
    if (argv[0] === 'stash' && argv[1] === 'list') return reply(`stash@{0}\x1f${STASH_SHA}\x1f2 hours ago\x1fOn feature: wip\n`)
    // An opened commit's files, and a stash's tracked ones: both.txt modified, old.txt renamed to new.txt.
    if (has('--name-status') && !has(`${STASH_SHA}^3`)) return reply('M\0both.txt\0R100\0old.txt\0new.txt\0')
    if (has('--numstat') && !has(`${STASH_SHA}^3`)) return reply('1\t1\tboth.txt\x000\t0\t\x00old.txt\x00new.txt\x00')
    // The stash's untracked files.
    if (has('--name-status', `${STASH_SHA}^3`)) return reply('A\0scratch.txt\0')
    if (has('--numstat', `${STASH_SHA}^3`)) return reply('1\t0\tscratch.txt\0')
    if (argv[0] === 'show' || argv[0] === 'diff') return reply(DIFF)
    return reply('')
  })
  on('tool.call', (_, e) => {
    const questions = (e as unknown as { questions?: { question: string }[] }).questions ?? []
    const question = questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions, answers: { [question]: answer } } as never }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const clock = mock.clock(on)
  const ran = (...args: string[]) => runs.some(r => args.every((a, i) => r[i] === a))
  return { runs, asked, ran, clock }
}

async function openTab($: Engine, clock: { advance: (ms: number) => Promise<void> }, tab: string, surface: 'terminal' | 'desktop' = 'desktop') {
  const pane = await $.ui.mount({ ...PANE, surface })
  await pane.press({ key: 'refresh' })
  await pane.press({ key: `tab:${tab}` })
  await clock.advance(0)
  return pane
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`History lists commits; a commit opens its files, a file its diff (${surface})`, async ($, on) => {
    const { ran, clock } = fakeGit(on)
    const pane = await openTab($, clock, 'history', surface)

    expect(ran('log', '-n51')).toBe(true)
    expect((await pane.find({ key: `commit:${SHA1}` }))?.text).toBe('▸ Tidy both')
    expect(await pane.find({ type: 'Text', text: 'feature, origin/feature' })).toBeDefined()

    await pane.press({ key: `commit:${SHA1}` })
    await clock.advance(0)
    expect(ran('show', '--name-status', '--first-parent', '-z', '-M', '--format=', SHA1)).toBe(true)
    expect((await pane.find({ key: `commit:${SHA1}` }))?.text).toBe('▾ Tidy both')
    expect((await pane.find({ key: `diff:commit|${SHA1}|new.txt` }))?.text).toBe('new.txt')

    await pane.press({ key: `diff:commit|${SHA1}|both.txt` })
    await clock.advance(0)
    expect(ran('show', '--format=', '--first-parent', '--no-color', '--no-ext-diff', '-M', SHA1, '--', 'both.txt')).toBe(true)
    const diff = await $.ui.mount({ ...PANE, requestId: 'git-things-diff', surface })
    expect(await diff.find({ type: 'Text', text: '  1 + ' })).toBeDefined()
    await diff.unmount()
    await pane.unmount()
  })
}

test('Load more asks git for the next page', async ($, on) => {
  // A full page plus one: there is more.
  const { ran, clock } = fakeGit(on)
  const pane = await openTab($, clock, 'history')
  expect(await pane.find({ key: 'history-more' })).toBeUndefined()
  await pane.unmount()
  expect(ran('log', '-n51')).toBe(true)
})

test('Stash: stash with a message, apply, pop, drop after asking', async ($, on) => {
  const { ran, asked, clock } = fakeGit(on, 'Drop')
  const pane = await openTab($, clock, 'stash')

  expect((await pane.find({ key: `stash:${STASH_SHA}` }))?.text).toBe('▸ On feature: wip')
  await pane.input({ key: 'stash-message', text: 'before rebase' })
  expect(ran('stash', 'push', '--include-untracked', '-m', 'before rebase')).toBe(true)

  await pane.press({ key: `apply:${STASH_SHA}` })
  expect(ran('stash', 'apply', 'stash@{0}')).toBe(true)
  await pane.press({ key: `pop:${STASH_SHA}` })
  expect(ran('stash', 'pop', 'stash@{0}')).toBe(true)
  await pane.press({ key: `drop:${STASH_SHA}` })
  expect(asked.at(-1)).toBe('Drop stash@{0} (On feature: wip)? Its changes will be lost.')
  expect(ran('stash', 'drop', 'stash@{0}')).toBe(true)
  await pane.unmount()
})

test('a stash opens its tracked changes and its untracked files', async ($, on) => {
  const { ran, clock } = fakeGit(on)
  const pane = await openTab($, clock, 'stash')

  await pane.press({ key: `stash:${STASH_SHA}` })
  await clock.advance(0)
  expect(ran('diff', '--name-status', '-z', '-M', `${STASH_SHA}^1`, STASH_SHA)).toBe(true)
  expect((await pane.find({ key: `diff:stash|${STASH_SHA}|both.txt` }))?.text).toBe('both.txt')
  expect((await pane.find({ key: `diff:commit|${STASH_SHA}^3|scratch.txt` }))?.text).toBe('scratch.txt')

  await pane.press({ key: `diff:stash|${STASH_SHA}|both.txt` })
  await clock.advance(0)
  expect(ran('diff', '--no-color', '--no-ext-diff', '-M', `${STASH_SHA}^1`, STASH_SHA, '--', 'both.txt')).toBe(true)
  await pane.unmount()
})

test('Compare: base defaults to origin/main, head to the branch; swap and pick', async ($, on) => {
  const { ran, clock } = fakeGit(on)
  const pane = await openTab($, clock, 'compare')

  expect((await pane.find({ key: 'compare-base' }))?.props.value).toBe('origin/main')
  expect((await pane.find({ key: 'compare-head' }))?.props.value).toBe('feature')
  expect(ran('log', '-n100', `--format=%H%x1f%h%x1f%an%x1f%ar%x1f%D%x1f%s%x1e`, 'origin/main..feature')).toBe(true)
  expect(ran('diff', '--name-status', '-z', '-M', '--no-ext-diff', 'origin/main...feature')).toBe(true)
  expect((await pane.find({ key: 'diff:compare|origin/main...feature|both.txt' }))?.text).toBe('both.txt')
  expect((await pane.find({ key: `commit:${SHA1}` }))?.text).toBe('▸ Tidy both')

  await pane.press({ key: 'compare-swap' })
  await clock.advance(0)
  expect(ran('diff', '--name-status', '-z', '-M', '--no-ext-diff', 'feature...origin/main')).toBe(true)

  await pane.select({ key: 'compare-base', value: 'main' })
  await clock.advance(0)
  expect(ran('diff', '--name-status', '-z', '-M', '--no-ext-diff', 'main...origin/main')).toBe(true)
  await pane.unmount()
})

test('git log parses into commits', () => {
  expect(parseLog(LOG)).toEqual([
    { sha: SHA1, short: '454312d', author: 'Alex', when: '19 hours ago', refs: 'HEAD -> feature, origin/feature', subject: 'Tidy both' },
    { sha: SHA2, short: 'ae4a674', author: 'Alex', when: '20 hours ago', refs: '', subject: 'init' },
  ])
})

test('name-status and numstat join into files, renames keep their old path', () => {
  expect(parseChangedFiles('M\0both.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0', '1\t1\tboth.txt\x000\t0\t\x00old.txt\x00new.txt\x000\t3\tgone.txt\x00')).toEqual([
    { path: 'both.txt', from: undefined, letter: 'M', added: 1, removed: 1 },
    { path: 'new.txt', from: 'old.txt', letter: 'R', added: 0, removed: 0 },
    { path: 'gone.txt', from: undefined, letter: 'D', added: 0, removed: 3 },
  ])
})

test('stash list parses, keyed by commit', () => {
  expect(parseStashes(`stash@{0}\x1f${STASH_SHA}\x1f2 hours ago\x1fOn feature: wip\n`)).toEqual([
    { ref: 'stash@{0}', sha: STASH_SHA, when: '2 hours ago', message: 'On feature: wip' },
  ])
})

test('the compare base prefers the remote main line, never the head', () => {
  const b = (name: string) => ({ name, isRemote: name.includes('/'), isCurrent: false, ahead: 0, behind: 0, isGone: false, when: '', subject: '' })
  expect(defaultBase([b('feature'), b('main'), b('origin/main')], 'feature')).toBe('origin/main')
  expect(defaultBase([b('feature'), b('master')], 'feature')).toBe('master')
  expect(defaultBase([b('main')], 'main')).toBe('')
})

test('a narrow pane cuts the subject and drops the refs; the date stays short', async ($, on) => {
  const { clock } = fakeGit(on)
  await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 30 } })
    .then(async pane => {
      await pane.press({ key: 'refresh' })
      await pane.press({ key: 'tab:history' })
      await clock.advance(0)
      expect((await pane.find({ key: `commit:${SHA1}` }))?.text).toBe('▸ Tidy …')
      expect(await pane.find({ type: 'Text', text: 'feature, origin/feature' })).toBeUndefined()
      expect(await pane.find({ type: 'Text', text: '19h' })).toBeDefined()
      await pane.unmount()
    })
})

test('names keep both ends, folders their last part, subjects their start', () => {
  expect(fitMiddle('rewrite-record-intelligence.md', 16)).toBe('rewrite…gence.md')
  expect(fitMiddle('plugins/git-things', 12, 0.3)).toBe('plu…t-things')
  expect(fitMiddle('short.ts', 16)).toBe('short.ts')
  expect(fitEnd('fix(catalog): allow 16-word labels', 14)).toBe('fix(catalog):…')
  expect(shortWhen('21 minutes ago')).toBe('21m')
  expect(shortWhen('4 days ago')).toBe('4d')
  expect(shortWhen('3 months ago')).toBe('3mo')
  expect(shortWhen('1 year, 2 months ago')).toBe('1y')
})

test('lines set the bar and the tabs apart, and titles head the commit columns', async ($, on) => {
  const { clock } = fakeGit(on)
  const pane = await openTab($, clock, 'history')
  // As wide as the pane: one under the bar, one under the tabs.
  const lines = await pane.findAll({ type: 'Text', text: '─'.repeat(PANE.props.bodyColumns) })
  expect(lines.length).toBe(2)
  for (const title of ['commit', 'message', 'author', 'age']) {
    expect(await pane.find({ type: 'Text', text: title })).toBeDefined()
  }
  await pane.unmount()
})
