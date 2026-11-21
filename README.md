# ai-stuff

A Claude Code plugin marketplace with small mods I've built.

## Plugins

### uncommitted-files

A side pane that lists the files in your session's git project that are not committed yet.

- Shows the branch and how far ahead or behind its remote it is.
- Lists each uncommitted file with its kind of change (modified, added, deleted, renamed, untracked, conflict) and whether it's staged.
- Updates right after Claude edits a file or runs a command, and every 5 seconds to catch your own edits.
- Puts a count in the status line: `● 3 uncommitted`, or `✓ clean`.
- `/uncommitted` reopens the pane if you closed it.

The pane opens by itself when a session starts. It reads the folder the session runs in, so that folder needs to be a git repository. It runs `git status` on your machine and sends nothing anywhere.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install uncommitted-files --marketplace vidi42/ai-stuff
```

Answer `y` to add the marketplace, then press Enter to install for your user (every session from then on).

From a shell:

```bash
claude plugin install uncommitted-files --marketplace vidi42/ai-stuff
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `vidi42/ai-stuff`, then **Add plugin**.

## License

MIT, see [LICENSE](LICENSE).
