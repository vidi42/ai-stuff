# ai-stuff

A Claude Code plugin marketplace with small mods I've built.

## Plugins

### git-things

A Git side pane that works like VS Code's Source Control view, for the git project your session runs in.

- **Header:** a branch picker, ahead/behind against the upstream, **Fetch**, **Pull** and **Push** (**Publish** for a new branch), and the branch's pull request as a link (or **Create pull request**).
- **Changes:** Merge, Staged and Changes groups. Each file has its status (M, A, D, R, U, !), its line counts, and buttons to open, stage, unstage or discard it. Click a file to see its diff in the **diff pane**, drawn like the Claude desktop app's diff panel; **view all** shows a whole group there. A commit box with **✨ Generate message** asks Claude for a message from your changes.
- **Branches:** local and remote branches with their last commit; switch, check out, delete, or create a new one.
- **History:** the branch's commits. Click one for its files, and a file for its diff in the diff pane.
- **Stash:** stash every change (untracked files included) with a message, then apply, pop or drop each stash, or look inside it.
- **Compare:** pick two branches to see the commits and files one has that the other lacks, as a pull request would show them.
- **Diff pane:** a pane of its own beside the lists, so a diff has nearly all the room a pane may draw (several hundred lines of one file). Click a file name there to show it alone, ✕ to drop it; closing the pane clears it.

It updates right after Claude edits a file or runs a command, and every 5 seconds to catch your own edits. The status line shows `● 3 changes ↑1`, or `✓ clean`. The pane doesn't open by itself: run `/git-things` to open it.

The pane runs `git` on your machine in the session's folder. Discarding, deleting a branch, dropping a stash and publishing a branch each ask first. Two features reach out: the pull request link uses the GitHub CLI (`gh`) if you have it, and **Generate message** sends the diff to Claude. Commits made from the pane skip the repository's git hooks (the plugin engine runs git with hooks off).

Options (in `/plugin`, or `pluginConfigs` in settings): **Open files with**, a command such as `code -g` (empty uses the system's default app), and **Commit message model** (default `haiku`).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install git-things --marketplace vidi42/ai-stuff
```

Answer `y` to add the marketplace, then press Enter to install for your user (every session from then on).

From a shell:

```bash
claude plugin install git-things --marketplace vidi42/ai-stuff
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `vidi42/ai-stuff`, then **Add plugin**.

## License

MIT, see [LICENSE](LICENSE).
