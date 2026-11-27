import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseDiff } from '../hooks/diff'
import { parseNumstat, parseStatus } from '../hooks/git'
import { toRows } from '../hooks/views/lines'

// Captured from a real repository: both.txt staged and changed again, gone.txt
// deleted, keep.txt modified, old.txt renamed to new.txt (staged), sub/new1.txt untracked.
const STATUS = [
  '# branch.oid ae4a6747b5bf7458a41ee49570aa2838f522f07a',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -2',
  '1 MM N... 100644 100644 100644 28ce6a8b26aa170e1de65536fe8abe1832bd3242 08bb2331e777f431177c40df6841c0034f89fb58 both.txt',
  '1 .D N... 100644 100644 000000 4bcfe98e640c8284511312660fb8709b0afa888e 4bcfe98e640c8284511312660fb8709b0afa888e gone.txt',
  '1 .M N... 100644 100644 100644 422c2b7ab3b3c668038da977e4e93a5fc623169c 422c2b7ab3b3c668038da977e4e93a5fc623169c keep.txt',
  '2 R. N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb R100 new.txt',
  'old.txt',
  '? sub/new1.txt',
  '',
].join('\0')
const BRANCHES = [
  ['refs/heads/main', 'main', 'origin/main', 'ahead 1, behind 2', '*', '4 hours ago', 'Init'],
  ['refs/heads/feature', 'feature', '', '', ' ', '2 days ago', 'Work in progress'],
  ['refs/remotes/origin/HEAD', 'origin', '', '', ' ', '4 hours ago', 'Init'],
  ['refs/remotes/origin/main', 'origin/main', '', '', ' ', '4 hours ago', 'Init'],
  ['refs/remotes/origin/topic', 'origin/topic', '', '', ' ', '1 day ago', 'Topic'],
]
  .map(f => f.join('\0'))
  .join('\n')
const STAGED_NUMSTAT = '1\t1\tboth.txt\x000\t0\t\x00old.txt\x00new.txt\x00'
const WORKTREE_NUMSTAT = '1\t1\tboth.txt\x000\t1\tgone.txt\x001\t1\tkeep.txt\x00'
const KEEP_DIFF = [
  'diff --git a/keep.txt b/keep.txt',
  'index 422c2b7..3b18e51 100644',
  '--- a/keep.txt',
  '+++ b/keep.txt',
  '@@ -1,2 +1,2 @@',
  ' a',
  '-b\r',
  '+B',
  '',
].join('\n')

const PANE = {
  plugin: 'git-things',
  component: 'Pane',
  requestId: 'git-things',
  props: {
    title: 'Git',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

type Run = { argv: string[]; stdin?: string }

/** Stands in for git in a repo at /repo, the session in /repo/sub; answers questions with `answer`. */
function fakeGit(on: On, answer = 'Cancel', status = STATUS, pr?: object, diffFor?: (argv: string[]) => string | undefined) {
  const runs: Run[] = []
  const asked: string[] = []
  const spawned: string[][] = []
  on('session.cwd', () => ({ value: '/repo/sub' }))
  on('session.info', () => ({ value: { platform: 'windows', transcriptPath: '', isHosted: false } as never }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'gh') {
      runs.push({ argv: [...e.argv] })
      return { value: (pr ? { exitCode: 0, stdout: JSON.stringify(pr), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no pull requests found' }) as never }
    }
    // Drop "git" and the leading `-c core.quotepath=off` every call carries.
    const argv = e.argv[1] === '-c' ? e.argv.slice(3) : e.argv.slice(1)
    runs.push({ argv, stdin: e.init?.stdin })
    const reply = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } as never })
    if (argv[0] === 'status') return reply(status)
    if (argv[0] === 'for-each-ref') return reply(BRANCHES)
    if (argv[0] === 'remote') return reply('git@github.com:octo/repo.git\n')
    if (argv[0] === 'symbolic-ref') return reply('', 128)
    if (argv[0] === 'rev-parse') return reply('/repo\n')
    if (argv.includes('--numstat')) return reply(argv.includes('--cached') ? STAGED_NUMSTAT : WORKTREE_NUMSTAT)
    const custom = argv[0] === 'diff' ? diffFor?.(argv) : undefined
    if (custom !== undefined) return reply(custom)
    if (argv[0] === 'diff' && argv.includes('keep.txt')) return reply(KEEP_DIFF)
    if (argv[0] === 'commit') return reply('[main 1234567] Fix it\n 1 file changed\n')
    return reply('')
  })
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    return { value: { code: 0, signal: null } }
  })
  // `$.ui.ask` is a call of the AskUserQuestion tool: answer it as a person picking `answer`.
  on('tool.call', (_, e) => {
    const questions = (e as unknown as { questions?: { question: string }[] }).questions ?? []
    const question = questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions, answers: { [question]: answer } } as never }
  })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const ran = (...args: string[]) => runs.some(r => args.every((a, i) => r.argv[i] === a))
  // Holds `$.clock` waits until a test moves it: diffs load on a timer.
  const clock = mock.clock(on)
  return { runs, asked, spawned, opened, ran, clock }
}

const mount = async ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') => {
  const pane = await $.ui.mount({ ...PANE, surface })
  await pane.press({ key: 'refresh' })
  return pane
}

/**
 * A drawing's serialized size, as the 100,000-character limit counts it. The kit
 * adds a `text` to each node it finds, for matching; the drawing has none.
 */
const drawnSize = (node: unknown) => JSON.stringify(node, (k, v) => (k === 'text' ? undefined : v)).length

/** The diff pane, as a surface draws it once opened. */
const mountDiff = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
  $.ui.mount({ ...PANE, requestId: 'git-things-diff', props: { ...PANE.props, title: 'diff' }, surface })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`files are grouped as VS Code groups them (${surface})`, async ($, on) => {
    fakeGit(on)
    const pane = await mount($, surface)

    expect((await pane.find({ key: 'branch' }))?.props.value).toBe('main')
    expect((await pane.find({ type: 'Text', text: /^→/ }))?.text).toBe('→ origin/main ↓2 ↑1')
    expect((await pane.find({ key: 'push' }))?.text).toBe('↑ Push 1')
    expect((await pane.find({ key: 'pull' }))?.text).toBe('↓ Pull 2')
    // both.txt is staged and changed again: it shows in both groups.
    expect(await pane.find({ key: 'unstage:both.txt' })).toBeDefined()
    expect(await pane.find({ key: 'stage:both.txt' })).toBeDefined()
    expect(await pane.find({ key: 'unstage:new.txt' })).toBeDefined()
    expect(await pane.find({ key: 'discard:sub/new1.txt' })).toBeDefined()
    expect((await pane.find({ key: 'diff:untracked||sub/new1.txt' }))?.text).toBe('new1.txt')
    // A deleted file has nothing to open.
    expect(await pane.find({ key: 'open:worktree||gone.txt' })).toBeUndefined()
    expect(await pane.find({ key: 'open:worktree||keep.txt' })).toBeDefined()
    await pane.unmount()
  })
}

test('clicking a file shows its diff in the diff pane, in place of the last one', async ($, on) => {
  const { ran, clock, opened } = fakeGit(on)
  const pane = await mount($)

  await pane.press({ key: 'diff:worktree||keep.txt' })
  await clock.advance(0)
  expect(ran('diff', '--no-color', '--no-ext-diff', '-M', '--', 'keep.txt')).toBe(true)
  expect(opened).toEqual(['git-things-diff'])
  // The list stays light: the row is marked, its diff draws in the other pane.
  expect((await pane.find({ key: 'diff:worktree||keep.txt' }))?.text).toBe('▶ keep.txt')
  expect(await pane.find({ type: 'Text', text: '2   - ' })).toBeUndefined()

  const diff = await mountDiff($)
  // Drawn as the desktop's diff panel: line-number gutters, then red and green lines.
  expect((await diff.find({ type: 'Text', text: '1 1   ' }))?.props.mono).toBe(true)
  expect(await diff.find({ type: 'Text', text: '2   - ' })).toBeDefined()
  expect(await diff.find({ type: 'Text', text: '  2 + ' })).toBeDefined()
  const backgrounds = (await diff.findAll({ type: 'Box' })).map(b => b.props.backgroundColor).filter(Boolean)
  expect(backgrounds).toEqual(['diffRemovedDimmed', 'diffAddedDimmed'])

  // Another file takes its place.
  await pane.press({ key: 'diff:staged||both.txt' })
  await clock.advance(0)
  expect((await pane.find({ key: 'diff:worktree||keep.txt' }))?.text).toBe('keep.txt')
  expect((await pane.find({ key: 'diff:staged||both.txt' }))?.text).toBe('▶ both.txt')

  await diff.unmount()
  await pane.unmount()
})

test('view all shows every staged diff in the diff pane; ✕ and a name narrow it', async ($, on) => {
  const { ran, clock } = fakeGit(on)
  const pane = await mount($)
  const diff = await mountDiff($)

  await pane.press({ key: 'all:staged' })
  await clock.advance(0)
  expect(ran('diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--', 'both.txt')).toBe(true)
  expect(ran('diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--', 'old.txt', 'new.txt')).toBe(true)
  expect(await diff.find({ type: 'Text', text: /^Staged Changes · HEAD → index/ })).toBeDefined()
  expect((await diff.find({ key: 'only:staged||both.txt' }))?.text).toBe('both.txt')
  expect((await diff.find({ key: 'only:staged||new.txt' }))?.text).toBe('new.txt')

  await diff.press({ key: 'hide:staged||both.txt' })
  expect(await diff.find({ key: 'only:staged||both.txt' })).toBeUndefined()
  // One file left: drawn on its own, with nothing to narrow.
  expect(await diff.find({ key: 'only:staged||new.txt' })).toBeUndefined()
  expect(await diff.find({ type: 'Text', text: 'new.txt' })).toBeDefined()
  await diff.unmount()
  await pane.unmount()
})

test('+ and − stage and unstage one file', async ($, on) => {
  const { ran } = fakeGit(on)
  const pane = await mount($)

  await pane.press({ key: 'stage:keep.txt' })
  expect(ran('add', '-A', '--', 'keep.txt')).toBe(true)
  await pane.press({ key: 'unstage:new.txt' })
  expect(ran('restore', '--staged', '--', 'old.txt', 'new.txt')).toBe(true)
  await pane.unmount()
})

test('discard asks first, and Cancel runs nothing', async ($, on) => {
  const { ran, asked } = fakeGit(on, 'Cancel')
  const pane = await mount($)

  await pane.press({ key: 'discard:keep.txt' })
  expect(asked[0]).toMatch(/Discard the changes in keep\.txt\?/)
  expect(ran('restore')).toBe(false)
  await pane.unmount()
})

test('discard all restores tracked files and deletes untracked ones once confirmed', async ($, on) => {
  const { ran, asked } = fakeGit(on, 'Discard')
  const pane = await mount($)

  await pane.press({ key: 'discard-all' })
  expect(asked[0]).toMatch(/Discard all 4 changes\? 1 untracked file will be deleted/)
  expect(ran('restore', '--worktree', '--', 'both.txt', 'gone.txt', 'keep.txt')).toBe(true)
  expect(ran('clean', '-f', '-q', '--', 'sub/new1.txt')).toBe(true)
  await pane.unmount()
})

test('Enter in the message box commits the staged changes with that message', async ($, on) => {
  const { runs } = fakeGit(on)
  const pane = await mount($)

  await pane.input({ key: 'commit-message', text: 'Fix it' })
  const commit = runs.find(r => r.argv[0] === 'commit')
  expect(commit?.argv).toEqual(['commit', '-F', '-'])
  expect(commit?.stdin).toBe('Fix it\n')
  expect((await pane.find({ key: 'commit-message' }))?.props.value).toBe('')
  await pane.unmount()
})

test('Generate fills the message box with the model reply', async ($, on) => {
  const { ran } = fakeGit(on)
  let prompt = ''
  on('model.complete', (_, e) => {
    prompt = String((e as { prompt?: unknown }).prompt)
    return { value: { isAnswered: true, text: '```\nRename old.txt and tidy both.txt\n```', usage: {} } as never }
  })
  const pane = await mount($)

  await pane.press({ key: 'generate' })
  expect(ran('diff', '--cached')).toBe(true)
  expect(prompt).toContain('Diff:')
  expect((await pane.find({ key: 'commit-message' }))?.props.value).toBe('Rename old.txt and tidy both.txt')
  await pane.unmount()
})

test('open ↗ uses the system default app', async ($, on) => {
  const { spawned } = fakeGit(on)
  const pane = await mount($)

  await pane.press({ key: 'open:worktree||keep.txt' })
  expect(spawned).toEqual([['explorer.exe', '\\repo\\keep.txt']])
  await pane.unmount()
})

test("the desktop draws one commit button, the field's own; the terminal gets one beside it", async ($, on) => {
  fakeGit(on)
  const desktop = await mount($, 'desktop')
  expect(await desktop.find({ key: 'commit' })).toBeUndefined()
  expect((await desktop.find({ key: 'commit-message' }))?.props.submitLabel).toBe('✓ Commit')
  await desktop.unmount()
  const terminal = await mount($, 'terminal')
  expect((await terminal.find({ key: 'commit' }))?.text).toBe('✓ Commit')
  await terminal.unmount()
})

test('open is an icon', async ($, on) => {
  fakeGit(on)
  const pane = await mount($)
  expect((await pane.find({ key: 'open:worktree||keep.txt' }))?.text).toBe('↗')
  await pane.unmount()
})

test('a changed line pairs with the line it replaced, and only the changed words are marked', () => {
  const rows = toRows(['@@ -3,2 +3,2 @@', '-  "version": "0.1.0",', '+  "version": "0.2.0",', '   "x": 1'].join('\n'))
  expect(rows).toEqual([
    { kind: 'hunk', text: '' },
    { kind: 'removed', old: 3, spans: [{ text: '  "version": "0.', changed: false }, { text: '1', changed: true }, { text: '.0",', changed: false }] },
    { kind: 'added', new: 3, spans: [{ text: '  "version": "0.', changed: false }, { text: '2', changed: true }, { text: '.0",', changed: false }] },
    { kind: 'context', old: 4, new: 4, spans: [{ text: '  "x": 1', changed: false }] },
  ])
})

test('view all turns into hide all, one toggle', async ($, on) => {
  fakeGit(on)
  const pane = await mount($)
  expect((await pane.find({ key: 'all:staged' }))?.text).toBe('view all')
  await pane.press({ key: 'all:staged' })
  expect((await pane.find({ key: 'all:staged' }))?.text).toBe('hide all')
  await pane.press({ key: 'all:staged' })
  expect((await pane.find({ key: 'all:staged' }))?.text).toBe('view all')
  expect((await pane.find({ key: 'diff:staged||both.txt' }))?.text).toBe('both.txt')
  await pane.unmount()
})

test('many large diffs still draw: lines past the budget become a note', async ($, on) => {
  // 30 modified files, each diff 2,000 changed lines.
  const files = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`)
  const status = [
    '# branch.oid ae4a6747b5bf7458a41ee49570aa2838f522f07a',
    '# branch.head main',
    ...files.map(f => `1 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${f}`),
    '',
  ].join('\0')
  const big = (path: string) =>
    [`diff --git a/${path} b/${path}`, '@@ -1,1000 +1,1000 @@', ...Array.from({ length: 1000 }, (_, i) => `-const old${i} = ${'x'.repeat(30)}`), ...Array.from({ length: 1000 }, (_, i) => `+const new${i} = ${'y'.repeat(30)}`), ''].join('\n')
  const { clock } = fakeGit(on, 'Cancel', status, undefined, argv => big(argv[argv.length - 1] ?? ''))
  const pane = await mount($)
  const diff = await mountDiff($)

  await pane.press({ key: 'all:changes' })
  for (let i = 0; i < 6; i++) await clock.advance(0)

  // Both panes drew (a refused drawing finds nothing), with the overflow counted.
  expect((await pane.find({ key: 'all:changes' }))?.text).toBe('hide all')
  expect(await diff.find({ type: 'Text', text: /more lines? not drawn/ })).toBeDefined()
  expect(await diff.find({ type: 'Text', text: /Not drawn: the files above fill the pane/ })).toBeDefined()
  // The desktop refuses a drawing past 100,000 serialized characters, and the kit does not check it.
  expect(drawnSize(await diff.find({ type: 'Box' }))).toBeLessThan(100000)
  expect(drawnSize(await pane.find({ type: 'Box' }))).toBeLessThan(100000)
  await diff.unmount()
  await pane.unmount()
})

test('one large diff gets most of the diff pane', async ($, on) => {
  const status = ['# branch.oid ' + 'a'.repeat(40), '# branch.head main', `1 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} big.ts`, ''].join('\0')
  const lines = Array.from({ length: 3000 }, (_, i) => `+const line${i} = ${i}`)
  const { clock } = fakeGit(on, 'Cancel', status, undefined, () => ['diff --git a/big.ts b/big.ts', '@@ -0,0 +1,3000 @@', ...lines, ''].join('\n'))
  const pane = await mount($)
  const diff = await mountDiff($)

  await pane.press({ key: 'diff:worktree||big.ts' })
  await clock.advance(0)
  // A run of lines shares one Text, each line's gutter a dim Text of its own.
  const drawn = (await diff.findAll({ type: 'Text', text: /\+ $/ })).length
  expect(drawn).toBeGreaterThan(800)
  expect(drawnSize(await diff.find({ type: 'Box' }))).toBeLessThan(100000)
  await diff.unmount()
  await pane.unmount()
})

test('view all returns before the diffs load, so hide all works at once', async ($, on) => {
  const { runs, clock } = fakeGit(on)
  const pane = await mount($)
  const diff = await mountDiff($)
  const diffsRun = () => runs.filter(r => r.argv[0] === 'diff' && !r.argv.includes('--numstat')).length

  await pane.press({ key: 'all:staged' })
  // The press is over: the diffs show as loading and nothing has run git yet.
  expect(diffsRun()).toBe(0)
  expect((await diff.findAll({ type: 'Text', text: 'Loading the diff…' })).length).toBe(2)
  expect((await pane.find({ key: 'all:staged' }))?.text).toBe('hide all')

  await pane.press({ key: 'all:staged' })
  await clock.advance(0)
  // Hidden before the timer ran: nothing left to load.
  expect(diffsRun()).toBe(0)
  expect(await diff.find({ type: 'Text', text: 'Loading the diff…' })).toBeUndefined()
  await diff.unmount()
  await pane.unmount()
})

test('counts leave out a zero side', async ($, on) => {
  fakeGit(on)
  const pane = await mount($)
  expect(await pane.find({ type: 'Text', text: '−1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /\+0/ })).toBeUndefined()
  await pane.unmount()
})

test('the branch picker switches branch', async ($, on) => {
  const { ran } = fakeGit(on)
  const pane = await mount($)
  await pane.select({ key: 'branch', value: 'feature' })
  expect(ran('switch', 'feature')).toBe(true)
  await pane.unmount()
})

test('Branches tab: switch, check out a remote branch, delete after asking', async ($, on) => {
  const { ran, asked } = fakeGit(on, 'Delete')
  const pane = await mount($)
  await pane.press({ key: 'tab:branches' })

  expect(await pane.find({ key: 'switch:main' })).toBeUndefined()
  expect((await pane.find({ key: 'switch:origin/main' }))?.text).toBe('switch')
  expect((await pane.find({ key: 'switch:origin/topic' }))?.text).toBe('check out')
  await pane.press({ key: 'switch:origin/topic' })
  expect(ran('switch', '--track', 'origin/topic')).toBe(true)
  await pane.press({ key: 'switch:origin/main' })
  expect(ran('switch', 'main')).toBe(true)
  await pane.press({ key: 'delete:feature' })
  expect(asked.at(-1)).toBe('Delete the branch feature?')
  expect(ran('branch', '-d', 'feature')).toBe(true)
  await pane.unmount()
})

test('a new branch is created from the field', async ($, on) => {
  const { runs } = fakeGit(on)
  const pane = await mount($)
  await pane.press({ key: 'tab:branches' })
  await pane.input({ key: 'new-branch', text: 'feature/x' })
  expect(runs.map(r => r.argv.join(' '))).toContain('switch -c feature/x')
  await pane.unmount()
})

test('a branch with no upstream is published after asking', async ($, on) => {
  const status = STATUS.replace('# branch.upstream origin/main\0# branch.ab +1 -2\0', '').replace('# branch.head main', '# branch.head feature')
  const { ran, asked } = fakeGit(on, 'Publish', status)
  const pane = await mount($)
  expect((await pane.find({ key: 'push' }))?.text).toBe('↑ Publish')
  await pane.press({ key: 'push' })
  expect(asked.at(-1)).toBe('feature is not on the remote yet. Publish it to origin?')
  expect(ran('push', '-u', 'origin', 'feature')).toBe(true)
  await pane.unmount()
})

test("the branch's pull request is linked", async ($, on) => {
  fakeGit(on, 'Cancel', STATUS, { number: 7, url: 'https://github.com/octo/repo/pull/7', state: 'OPEN', isDraft: false, title: 'Add git-things' })
  const pane = await mount($)
  const link = await pane.find({ type: 'Link' })
  expect(link?.props.href).toBe('https://github.com/octo/repo/pull/7')
  expect(link?.text).toContain('PR #7 Add git-things ↗')
  await pane.unmount()
})

test('with no pull request, a branch other than the default links to creating one', async ($, on) => {
  const status = STATUS.replace('# branch.head main', '# branch.head feature/x')
  fakeGit(on, 'Cancel', status)
  const pane = await mount($)
  const link = await pane.find({ type: 'Link' })
  expect(link?.props.href).toBe('https://github.com/octo/repo/pull/new/feature/x')
  expect(link?.text).toContain('Create pull request ↗')
  await pane.unmount()
})

test('porcelain v2 status parses into groups, branch and upstream', () => {
  const s = parseStatus(STATUS)
  expect([s.branch, s.oid, s.upstream, s.ahead, s.behind]).toEqual(['main', 'ae4a674', 'origin/main', 1, 2])
  expect(s.entries).toEqual([
    { group: 'staged', letter: 'M', path: 'both.txt', from: undefined },
    { group: 'changes', letter: 'M', path: 'both.txt' },
    { group: 'changes', letter: 'D', path: 'gone.txt' },
    { group: 'changes', letter: 'M', path: 'keep.txt' },
    { group: 'staged', letter: 'R', path: 'new.txt', from: 'old.txt' },
    { group: 'changes', letter: '?', path: 'sub/new1.txt' },
  ])
})

test('numstat counts skip binaries and follow renames', () => {
  const counts = parseNumstat('3\t1\ta.ts\x00-\t-\timg.png\x002\t0\t\x00old.ts\x00new.ts\x00')
  expect([...counts]).toEqual([
    ['a.ts', { added: 3, removed: 1 }],
    ['new.ts', { added: 2, removed: 0 }],
  ])
})

test('a diff too long to draw is cut at a line, and the cut hunk still parses', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`)
  const out = ['diff --git a/big.txt b/big.txt', 'new file mode 100644', '--- /dev/null', '+++ b/big.txt', '@@ -0,0 +1,5000 @@', ...lines].join('\n')
  const parsed = parseDiff(out)
  const section = parsed.sections[0]

  expect(parsed.added).toBe(5000)
  expect(parsed.omitted).toBeGreaterThan(0)
  expect(section?.title).toBe('big.txt')
  expect(section?.notes).toEqual(['new file mode 100644'])
  const kept = section?.hunks.split('\n') ?? []
  expect(kept[0]).toBe(`@@ -0,0 +1,${kept.length - 1} @@`)
  expect(parsed.size).toBeLessThanOrEqual(60000)
})

test('a new session leaves the pane closed; /git-things opens it', async ($, on) => {
  const { opened } = fakeGit(on)
  on('command.register', () => ({ value: undefined as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo/sub', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual([])

  const { text } = await $.command.run({ command: 'git-things', args: '' } as never)
  expect(opened).toEqual(['git-things'])
  expect(text).toContain('git-things pane opened')
})
