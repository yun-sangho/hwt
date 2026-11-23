# hwt

Git worktrees as Herdr spaces, plus a small ledger for running many coding agents in
parallel on one repo.

```sh
hwt new feat/login --title "Fix login" --task "Fix the login redirect loop; add a test"
```

makes a checkout at `~/.herdr/worktrees/<repo>/feat-login`, runs the repo's setup there, and opens a Herdr
space with an agent (Claude Code by default) working on the task. `hwt rm feat/login -D` closes the space
and removes the checkout and branch.

On top of that, hwt has an optional **main-session workflow**: one agent in the main checkout talks to you,
keeps the task list, hands work to agents in worktrees, and merges their PRs one at a time. Its state lives
in a ledger under `.git/hwt/`, so a restarted session picks up where the last one stopped.

## Requirements

- git 2.38+
- Herdr (`herdr-app` and `hc`), running, for `hwt new` (or pass `--no-space` for the checkout only)
- optional: `gh` (the merge queue checks PRs and CI with it), `claude` / `codex`

`hwt doctor` checks all of it.

## Install

```sh
brew install yun-sangho/tap/hwt
```

Or download the binary for your platform from the releases page and put it on your PATH, or build it:

```sh
bun install && bun run build      # → dist/hwt
cp dist/hwt ~/.local/bin/
```

Optional shell wrapper, so `hwt rm` run from inside the removed checkout drops you in the main one:

```sh
eval "$(hwt shell-init zsh)"      # or bash / fish
```

## Repo setup

```sh
hwt init                    # .hwt.json with a setup guessed from your lockfile
hwt init --main-session     # …and the main-session workflow
```

`.hwt.json`:

```json
{
  "version": 1,
  "setup": "pnpm install",
  "mainSession": true,
  "mergeApproval": { "paths": ["db/migrations/**", ".github/workflows/**"], "maxLines": 400 },
  "agent": "claude",
  "lang": "en"
}
```

| key | meaning |
| --- | --- |
| `setup` | Runs once in a checkout `hwt new` creates, in the new space's terminal before the agent starts. Herdr starts that terminal through your login shell, so your PATH (nvm, …) is there. Failing setup is reported, never fatal. |
| `mainSession` | `new`/`rm` only from the main checkout; working sessions report with `hwt tell`. |
| `mergeApproval` | Merges touching these globs, or bigger than `maxLines`, need the person's yes. |
| `agent` | Default agent command for `hwt new`. |
| `lang` | `en` or `ko`: the instructions hwt gives agents and its message tags. |

User defaults go in `~/.config/hwt/config.json` (`root`, `agent`, `lang`). Checkouts go where Herdr's own
*New worktree* puts them (`worktrees.directory` in Herdr's settings, default `~/.herdr/worktrees`), or
`root` / `HWT_ROOT`.

### What hwt expects from a repo

- **Setup is safe to run twice**, and the repo's own scripts cope with a checkout that never ran it
  (checkouts made from Herdr's sidebar or plain `git worktree add` don't run setup).
- **There is no teardown.** `hwt rm` only removes. Anything a checkout starts (databases, ports, dev
  servers) must be reclaimable after the checkout is gone: name resources after the checkout and give the
  repo a `gc` that removes the ones whose checkout no longer exists. The main session runs it after `rm`.
  This way the cleanup works however a checkout was removed.

## Commands

Worktrees

```
hwt new <branch> [--agent claude|codex|none|<cmd>] [--task TEXT] [--title T]
                 [--task-id ID] [--resume-from ID [--fork]] [--no-space] [--no-hooks]
hwt rm [<branch>] [-f] [-D] [--kill-agents]
hwt ls | send <worktree> TEXT | title <worktree> TEXT
```

Main-session workflow

```
hwt claim | main | status [--prs] | wait [--timeout S]
hwt tell TEXT | inbox [--all] | ack <id>...|--all | note [--branch B] TEXT|--drop N
hwt task add TITLE [--touches p1,p2] | ls [--all] | decide <id> now|later|after:<branch> --why T | done|drop <id>
hwt mq add [--pr N] [TEXT] | ls [--all] | next | set <id> <state> [--why T] | approve <id>
```

Setup: `hwt init`, `hwt doctor`, `hwt shell-init`, `hwt hook session-start`.

stdout is JSON; progress goes to stderr.

## Agents

Any command works as `--agent`; the task goes in as its last argument. For agents hwt knows, it also
handles session ids, so a lost session can be reopened with `hwt new <branch> --resume-from <id>`:

| | Claude Code | Codex |
| --- | --- | --- |
| session id | chosen up front (`--session-id`) | found after start (`~/.codex/sessions`) or from `$CODEX_THREAD_ID` on the first `tell` |
| resume / fork | `--resume` / `--fork-session` | `resume` / `fork` subcommands |
| added options | — | `--no-daemon -C <worktree> -s danger-full-access -a on-request` (its sandbox can't write a linked worktree's git metadata) |

## Agent integration

- Claude Code: copy `skills/hwt/SKILL.md` to `~/.claude/skills/hwt/` and add a SessionStart hook running
  `hwt hook session-start`. In a main-session repo it tells each new session whether it is the main or a
  working session and what the ledger holds.
- Other agents: point them at the same SKILL.md from their instructions file.

## Development

```sh
bun test           # end-to-end tests with fake herdr-app / hc on PATH
bun run typecheck
bun run build      # or: bun scripts/build.ts --all
```
