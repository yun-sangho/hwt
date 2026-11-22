---
name: hwt
description: Use when creating or removing git worktrees, or when working the main-session way (task list, handing work to working sessions, inbox, merge queue). Use hwt instead of `git worktree add`, EnterWorktree or a task-list file in the repo whenever you split work onto a branch, hand work to another agent in an isolated checkout, the user asks for a worktree, a new task arrives, or the user asks what tasks are registered.
---

# hwt: worktrees as Herdr spaces

`hwt` is on PATH. stdout is JSON; progress goes to stderr. Run it from inside the repo (any checkout).

## Rules

- Make and remove worktrees only with hwt. Don't use `git worktree add`, EnterWorktree or `.claude/worktrees/`.
- Checkouts live at `<worktrees root>/<repo>/<branch slug>` (Herdr's New worktree rule), so they show under the repo in Herdr's sidebar.
- `hwt new` refuses when Herdr isn't running; `--no-space` makes the checkout only.

## Main-session workflow (`"mainSession": true` in the main checkout's .hwt.json)

- **Main session** = the agent in the main checkout. It talks with the person, decides tasks, creates and removes worktrees, merges, verifies deploys and cleans up. It doesn't edit files in the main checkout; implementation, investigation and tests go to working sessions.
- **Working session** = an independent agent in one worktree (not the main's child). It changes only its worktree, never creates/removes worktrees, never merges.
- **State lives in the ledger, not in the conversation**: `<main checkout>/.git/hwt/` (`ledger.json`, `inbox.jsonl`, `acked`). Every checkout sees it; it is never committed.
- **The task list is `hwt task`.** Don't keep a task-list file in the repo. "What's left?" → `hwt task ls --all`, `hwt status`.

### Main session

```sh
hwt claim                     # at session start (the session-start hook does it): this terminal is the main
hwt status [--prs]            # one-page restore: notes, tasks, merges, unread messages, worktrees, PRs
hwt note [--branch B] "…"     # record the person's decisions and permissions the moment you get them
hwt inbox [--all] / ack <id>  # working sessions' messages; ack what you handled
hwt wait [--timeout S]        # when waiting (not hc wait --children: it ends early on old messages)
hwt send <worktree> "…"       # to a working session, whatever its terminal id is now
```

**Tasks** — everything the person asks for and every `[task proposal]` goes in the ledger; the main decides.
```sh
hwt task add "<no> <title>" --touches path1,path2 [--detail "…"]
hwt task ls [--all]           # with overlaps: running branches touching the same paths
hwt task decide <id> now|later|after:<branch> --why "…"
hwt new <branch> --title "<no> short title" --task "<instructions>" --task-id <id>   # → running
hwt task done|drop <id> [--why "…"]
```
- `now`: no overlap, no dependency on other results
- `after:<branch>`: same files or screen flow, depends on that PR, both change the DB schema, both edit shared rule docs
- `later`: the person set the order or the scope is unclear → ask, then `note`
- A small follow-up inside a running session's PR scope: `send` it to that session instead of a new task
- If deciding needs code reading, start a read-only investigation session instead of reading in the main

**Instructions (`--task`)**: scope, done criteria, verification commands, and "open a PR; when CI passes run `hwt mq add --pr <n>` and wait until it is merged". hwt appends how to report (`hwt tell`) itself.

**Naming**: call working sessions "worktree (title)", e.g. `feat-t14-slot-edit (T14 edit slot)`; never by terminal or session id. Their terminals carry the label `hwt.worktree=<worktree>`.

**Merge queue** — merging, deploy checks and cleanup are the main's, one at a time.
```sh
hwt mq ls [--all] / mq next   # checks: dirty, ahead, behind, conflict, PR/CI, lines, approval (auto|user)
hwt mq set <id> merging|verifying|done|returned|failed|waiting_user [--why "…"]
hwt mq approve <id>           # the person said yes
```
1. `mq next` → a failed check (conflict, behind, CI, dirty) → `returned` + `hwt send <worktree> "[rebase request] …"`
2. If a `note` says something about this PR, follow it. Otherwise `approval: auto` → merge; `user` → `waiting_user`, ask the person with the reason. You may raise auto to user after reading the PR, never lower user to auto
3. `merging`: `gh pr merge <n>` → `verifying`: the repo's deploy check, if it has one
4. Passed → `done` → `hwt rm <branch> -D --kill-agents` + `git push origin --delete <branch>` → the repo's gc (see its AGENTS.md) for whatever the checkout left behind → revisit `after:<branch>` tasks. Failed → `failed`, hand the log to the working session to fix in the same worktree
- Check the PR, CI and commits yourself before trusting a working session's report

**Restarted main**: `hwt claim` → `hwt status --prs` → take the notes as given, check items stuck in `merging`/`verifying`, handle and ack unread messages; a ledger-`active` session with no terminal → `hwt new <branch> --resume-from <session>` (`--fork` if the original terminal is still alive).

### Working session

```sh
hwt tell "[…] …"              # to the main: inbox first, then the live main session. Never hc send
hwt task add "<title>" --touches …   # propose separate follow-up work instead of doing it
hwt mq add --pr <n> "summary" # after the PR's CI passes; stay up until merged, handle returned/failed
```
- Send the main only what it decides: `[worktree request]`, `[task proposal]`, `[merge request]`, `[decision]` (an answer from the person that other work depends on), anything affecting other work. Short; long text goes in a file or the PR body
- Questions that only matter inside this task: ask the person directly on your screen
- `hwt new` / `hwt rm` are refused in a working worktree (expected). People can override with `HWT_ANYWHERE=1`

## hwt new

```sh
hwt new feat/x --title "T3 login fix" --task "<instructions>" [--task-id <id>]
hwt new feat/x --agent codex --task "…"
hwt new feat/x --resume-from <session id> [--fork]
hwt new feat/x --agent none        # just a shell
hwt new feat/x --no-space          # checkout only
```
- The task becomes the agent's first prompt. Claude gets a `--session-id` chosen up front and recorded in the ledger
- Working sessions are always independent agents (no parent). For a child agent of your own, use `hc run` instead
- `created: false` = existing checkout reused; `reused_space: true` = its space was already open (no new agent → `hwt send`)
- One agent per worktree

## .hwt.json

```json
{ "setup": "pnpm install", "mainSession": true,
  "mergeApproval": { "paths": ["db/**", ".github/workflows/**", "AGENTS.md"], "maxLines": 400 } }
```
- `setup`: once, only in checkouts `hwt new` creates, in the new space's terminal before the agent (with `--no-space`, right away). Failing setup only warns. `--no-hooks` skips it. Checkouts made elsewhere get no setup; the repo's scripts should prepare themselves
- No teardown: `rm` only removes. What a checkout leaves behind is reclaimed by the repo's gc, which the main runs after `rm`
- `mergeApproval`: matching paths or more lines → the person approves the merge

## hwt rm

```sh
hwt rm feat/x [-D] [--kill-agents]
```
- Refuses while an agent terminal is live in the checkout: `hc read <id>` to check it isn't working, then `--kill-agents`
- Refuses with uncommitted changes. `-f` (discard them) only with the person's explicit permission
- `-D` only when the branch is merged or the person allowed it
- Don't remove worktrees you didn't make (the person's or another agent's) without asking
