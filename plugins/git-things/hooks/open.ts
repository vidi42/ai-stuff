import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { basename, clean } from './git'
import { SNAPSHOT } from './state'

const snapshot = atom({ plugin: 'git-things', key: 'snapshot' } as const, SNAPSHOT, { shape: 'snapshot-1' })

/** Splits a command line into words, keeping "quoted parts" whole. */
const words = (command: string) =>
  (command.match(/"[^"]*"|\S+/g) ?? []).map(w => w.replace(/^"(.*)"$/, '$1'))

/** Starts a command and resolves once it ends; `started` false when it could not start. */
async function launch(
  $: EngineInterface,
  argv: string[],
  cwd: string,
): Promise<{ started: boolean; code: number | null; stderr: string }> {
  const child = $.process.spawn({ argv, cwd })
  let stderr = ''
  try {
    for await (const { stream, text } of child) if (stream === 'stderr') stderr += text
  } catch (err) {
    return { started: false, code: null, stderr: String(err) }
  }
  const { code } = await child.result
  return { started: true, code, stderr }
}

/** Opens a file of the repo with the `openWith` command, or else the system's default app for it. */
export async function openFile($: EngineInterface, path: string, openWith: string): Promise<void> {
  const { top } = await read($, snapshot)
  if (!top) return
  const { platform } = await $.session.info()
  const isWindows = platform === 'windows'
  const absolute = `${top}/${path}`.replace(/\/$/, '')
  const file = isWindows ? absolute.replace(/\//g, '\\') : absolute
  const command = words(openWith)

  let ran
  if (command.length > 0) {
    ran = await launch($, [...command, file], top)
    // On Windows most editor launchers (code, cursor) are .cmd files, which only cmd runs.
    if (!ran.started && isWindows) ran = await launch($, ['cmd', '/d', '/c', ...command, file], top)
  } else {
    const opener = isWindows ? 'explorer.exe' : platform === 'macos' ? 'open' : 'xdg-open'
    ran = await launch($, [opener, file], top)
    // explorer.exe exits with 1 even when it opened the file.
    if (isWindows && ran.started) return
  }
  if (!ran.started || (ran.code !== null && ran.code !== 0)) {
    const why = clean(ran.stderr.trim()).split('\n')[0] || `exit code ${ran.code}`
    $.ui.toast(`Could not open ${basename(path)}: ${why}`)
  }
}
