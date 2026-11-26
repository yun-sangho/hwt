# hwt

Git worktrees as Herdr spaces, plus a small ledger for running many coding agents in
parallel on one repo.

```sh
hwt new feat/login --title "Fix login" --task "Fix the login redirect loop; add a test"
```

makes a checkout at `~/.herdr/worktrees/<repo>/feat-login`, runs the repo's setup there, and opens a Herdr
space with an agent (Claude Code by default) working on the task. `hwt rm feat/login -D` closes the space
and removes the checkout and branch.

Outside git, `hwt new docs --task "…"` opens the child in the same folder (or `--dir sub`) with no checkout:
children share the files, hwt tells them apart by the `HWT_CHILD`/`HWT_PROJECT` it starts them with, and the
ledger lives in `~/.local/state/hwt/projects/`. Everything but the merge queue works the same.

On top of that, hwt has an optional **main-session workflow**: main sessions talk to you, keep the task
list, hand work to agents in worktrees, and merge their PRs one at a time. There can be several mains, each
owning the worktrees it made: by default every agent in the main checkout is one, and a working session can
become a main of its own with `hwt claim` in its worktree. State lives in a ledger under `.git/hwt/`, so a
restarted session picks up where the last one stopped. Writes take a lock and keep the ledger they replace as
`ledger.json.bak`; a ledger hwt can't read stops the command rather than being read, and overwritten, as empty.

Mains are woken only for decisions (merge approvals, task proposals, unblocked tasks, a working session's
`hwt tell`); merge requests, returns and deploy failures are log entries (`hwt inbox --log`). The PR, its
review and fixes stay in the working session.

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

## Repo setup

```sh
hwt init                    # .hwt.json with a setup guessed from your lockfiles
hwt init --main-session     # …and the main-session workflow
```

`.hwt.json`:

```json
{
  "version": 1,
  "setup": "pnpm install",
  "mainSession": true,
  "mergeApproval": { "paths": ["db/migrations/**", ".github/workflows/**"], "maxLines": 400 },
  "mergeQueue": { "method": "squash", "verify": "scripts/check-deploy", "gc": "make gc" },
  "agent": "claude",
  "lang": "en"
}
```

| key | meaning |
| --- | --- |
| `setup` | Runs once in a checkout `hwt new` creates, in the new space's terminal before the agent starts. Herdr starts that terminal through your login shell, so your PATH (nvm, …) is there. Failing setup is reported, never fatal. |
| `mainSession` | `new`/`rm` only from a main session (the main checkout, or a worktree that claimed); working sessions report to their own main with `hwt tell`. |
| `mergeApproval` | Merges touching these globs, or bigger than `maxLines`, need the person's yes. |
| `mergeQueue` | How `hwt mq run` drains the queue: `method` (squash), `verify` (deploy check), `verifyTimeout`, `cleanup` (true), `gc`, `maxUpdates` (3), `requireChecks` (true with .github/workflows: a PR waits until its checks show up), `base`. |
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
hwt new <branch|name> [--agent claude|codex|none|<cmd>] [--task TEXT] [--title T]
                 [--task-id ID] [--resume-from ID [--fork]] [--dir D] [--no-space] [--no-hooks]
hwt rm [<branch>] [-f] [-D] [--kill-agents]
hwt ls | send <worktree> TEXT | title <worktree> TEXT
```

Main-session workflow

```
hwt claim | adopt <worktree>... | main | status [--prs] | wait [--timeout S]
hwt mains [ls] | mains prune [--release] [--dry-run]
hwt tell TEXT | inbox [--all] [--log] | ack <id>...|--all | note [--branch B] TEXT|--drop N
hwt task add TITLE [--touches p1,p2] | ls [--all] [--every-main] | decide <id> now|later|after:<branch> --why T | done|drop <id>
hwt mq add [--pr N] [--after b1,b2] [--priority N] [TEXT] | ls [--all] | next | log <id>
hwt mq run [--watch] [--interval S] [--timeout S] [--dry-run]
hwt mq approve <id> | drop <id> | prio <id> <n> | set <id> <state> [--why T] [--force]
```

While a PR waits in GitHub's merge queue, the runner checks the other PRs and sends approval requests.
It can also submit eligible PRs up to each GitHub queue's reported build limit. The runner waits for
dependencies declared with `--after` and serializes submissions when `mergeQueue.verify` or
`mergeQueue.gc` is configured. Use `hwt mq next` or `hwt mq run --dry-run` to inspect the plan.

Setup: `hwt init`, `hwt doctor`, `hwt install` / `uninstall`, `hwt hook session-start`.

Optional, only without the main-session workflow (there `hwt rm` runs in the main checkout): run in
the checkout it removes, `hwt rm` leaves your shell in a deleted folder. `eval "$(hwt shell-init zsh)"`
(or bash / fish) in your shell's rc file adds a wrapper that moves you to the main checkout instead.

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

```sh
hwt install claude --lang ko     # or en; claude | codex | all
hwt install all --dry-run        # show what would change
hwt uninstall claude
```

- **Claude Code**: writes the skill to `~/.claude/skills/hwt/SKILL.md` and adds a SessionStart hook running
  `hwt hook session-start` to `~/.claude/settings.json` (other settings are kept; the old file is saved as
  `settings.json.hwt-backup`). In a main-session repo the hook claims each session in the main checkout as a
  main, and tells each new session whether it is a main or a working session and what of the ledger is its own.
- **Codex**: writes the skill to `~/.codex/skills/hwt/SKILL.md` and a marked block to `~/.codex/AGENTS.md`.
  Codex has no session-start hook, so the block tells it to run `hwt hook session-start` itself. Your own
  text in AGENTS.md is left alone; only the block between the `hwt:begin` / `hwt:end` markers is managed.
- Running it again is safe; it changes only what differs. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured.
  `hwt doctor` reports whether both are installed.

## Development

```sh
bun test           # end-to-end tests with fake herdr-app / hc on PATH
bun run typecheck
bun run build      # or: bun scripts/build.ts --all
```

Releasing: bump `version` in package.json and push to main. `auto-tag` tags `v<version>`, and `release`
builds the binaries, publishes the GitHub release and bumps `Formula/hwt.rb` in the tap (with the
`TAP_TOKEN` secret; without it the job warns and the tap is updated by hand with
`bun scripts/brew-formula.ts <version>`).
