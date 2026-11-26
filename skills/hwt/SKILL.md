---
name: hwt
description: Use when creating or removing git worktrees, or when working the main-session way (task list, handing work to working sessions, inbox, merge queue). Use hwt instead of `git worktree add`, EnterWorktree or a task-list file in the repo whenever you split work onto a branch, hand work to another agent in an isolated checkout, the user asks for a worktree, a new task arrives, or the user asks what tasks are registered.
---

# hwt: worktrees as Herdr spaces

`hwt` is on PATH. stdout is JSON; progress goes to stderr. Run it from inside the repo (any checkout).

## Rules

- **Git repo**: each child session gets its own worktree. **Plain folder** (no git): `hwt new <name> --task …` opens the child in a Herdr space in the same folder (or `--dir <subfolder>`), with no checkout. Folder children share files, so give them separate files or subfolders; they have no PR or merge queue and report `[done]` with `hwt tell`. Their ledger is in `~/.local/state/hwt/projects/`. A folder takes part in session-start briefings only with a `.hwt.json` (`hwt init` works there too)

- In a git repo, make and remove worktrees only with hwt. Don't use `git worktree add`, EnterWorktree or `.claude/worktrees/`.
- Checkouts live at `<worktrees root>/<repo>/<branch slug>` (Herdr's New worktree rule), so they show under the repo in Herdr's sidebar.
- `hwt new` refuses when Herdr isn't running; `--no-space` makes the checkout only.

## Main-session workflow (`"mainSession": true` in the main checkout's .hwt.json)

- **There are several main sessions, each with its own working sessions.** Don't assume you are the only main.
- **Main session** = an agent that talks with the person, decides tasks, creates and removes worktrees, merges, verifies deploys and cleans up. By default every agent session in the main checkout is a main (the session-start hook claims it). It doesn't edit files where it works; implementation, investigation and tests go to its working sessions.
- **Working session** = an independent agent in one worktree, owned by the main that made it (`owner` in the ledger). It reports only to that main, changes only its worktree, never creates/removes worktrees, never merges.
- **A working session can become a main of its own**: when the person wants it (e.g. its work should split further), it runs `hwt claim` in its worktree. It then owns that worktree and its PR, can `hwt new` its own working sessions (branched off its branch), and its old main gets a `[now a main]` message and stops managing it.
- **A main's identity** is its agent session id (survives resume), else its hc terminal. A new session in a main's terminal takes over that main's worktrees, tasks and notes. A main that is gone for good: another main takes its worktrees with `hwt adopt <worktree>`.
- **What is yours**: worktrees you made or adopted, their tasks, notes, inbox and merge requests. Records with no owner belong to every main. Don't send to, merge, or remove another main's worktrees; ask the person, or `adopt` with their OK.
- **State lives in the ledger, not in the conversation**: `<main checkout>/.git/hwt/` (`ledger.json`, `inbox.jsonl`, `acked`). Every checkout and every main sees it; it is never committed. If hwt says it can't read `ledger.json`, stop and tell the person (the message names the `ledger.json.bak` copy from before the last write); never delete or recreate the ledger.
- **A main is woken only for a decision.** What reaches its terminal (a turn in its conversation): `[merge approval]`, `[task proposal]`, `[unblocked]`, and a working session's `hwt tell` (`[decision]`, `[worktree request]`). Everything else is a log entry in the ledger, read on demand (`hwt inbox --log`, `status.log_recent`): merge requests, returns, rebase requests, deploy failures, `[now a main]`. The PR, its review, CI fixes, rebases and re-queuing all stay in the working session.
- **The task list is `hwt task`.** Don't keep a task-list file in the repo. "What's left?" → `hwt task ls --all`, `hwt status` (yours; `task ls --every-main` for all mains').

### Main session

```sh
hwt claim                     # at session start (the session-start hook does it in the main checkout); other mains stay mains
hwt status [--prs] [--full]   # one-page restore: mains, your notes/tasks/unread messages, all merges and worktrees (mine: true = yours), PRs. Notes on finished branches (notes_hidden) and long task texts are left out; --full shows all
hwt adopt <worktree>...       # take over a gone main's worktrees (their unread mail comes with them)
hwt mains [ls]                # every main: live, owns
hwt mains prune [--release] [--dry-run]   # forget gone mains; ones still owning worktrees stay unless --release (their work becomes unowned)
hwt note [--branch B] "…"     # record the person's decisions and permissions the moment you get them
hwt note --drop <n>           # remove a note that is wrong or no longer true (n: the note's n in hwt status). Prune when status shows notes_hint
hwt inbox [--all] / ack <id>  # messages that need your decision; ack what you handled. ack --all takes only messages already shown to you (inbox, wait, status) and prints the others to read first
hwt inbox --log               # the log: what happened that needs no decision (merge requests, returns, deploy failures)
hwt wait [--timeout S]        # when waiting (not hc wait --children: it ends early on old messages)
hwt send <worktree> "…"       # to one of your working sessions, whatever its terminal id is now. If it fails, hc read the terminal before sending again: it may have arrived
hwt hold <worktree> "<why>"   # keep it until the person releases it: rm and mq cleanup leave it. hold --release <worktree> when they say so
```
- `hwt note` is the main's alone: a working session reports a decision with `hwt tell "[decision] …"` and you note it

**Tasks** — everything the person asks for and every `[task proposal]` goes in the ledger; the main decides.
```sh
hwt task add "<title>" --touches path1,path2 [--detail "…"]
hwt task ls [--all] [--every-main]  # yours; overlaps: running branches of any main touching the same paths
hwt task decide <id> now|later|after:<branch> --why "…"
hwt new <branch> --title "<short title>" --task "<instructions>" --task-id <id>   # → running
hwt task done|drop <id> [--why "…"]
```
- `now`: no overlap, no dependency on other results
- `after:<branch>`: same files or screen flow, depends on that PR, both change the DB schema, both edit shared rule docs. The branch may be another main's
- `later`: the person set the order or the scope is unclear → ask, then `note`
- A small follow-up inside a running session's PR scope: `send` it to that session instead of a new task
- If deciding needs code reading, start a read-only investigation session instead of reading in the main
- `hwt new` refuses past the repo's `maxActive` (worktrees open at once): `decide <id> later --why "maxActive"` and start it when one is merged. `--over-limit` only when the person asks
- Work the person has to look at before it goes (a guide, research, a design, docs to review): `hwt new … --hold "<what they will check>"`. A working session's "done" or "can be cleaned up" is not the person's word: never `rm` such a worktree until the person tells you, then `hold --release`

**Instructions (`--task`)**: scope, done criteria, verification commands, and "push, open a PR, run `hwt mq add --pr <n>` and stay up until it is merged". hwt appends how to report (`hwt tell`, only for decisions) itself.

**Naming**: call working sessions "worktree (title)", e.g. `feat-slot-edit (edit slot)`; never by terminal or session id. Titles are plain words: no numbers of your own ("T14 …"). They aren't the task's id, don't survive a restart or another main, and collide; the task is linked by `--task-id`. Their terminals carry the label `hwt.worktree=<worktree>`.

**Merge queue** — a queue in the ledger, drained by `hwt mq run`. One runner per repo processes every main's items and tells each owner what needs attention.
```sh
hwt mq run [--watch] [--interval S] [--timeout S]   # --watch keeps checking CI and GitHub queue status
hwt mq run --dry-run          # what it would do for each item, changing nothing
hwt mq ls [--all] / mq next   # place in line, owner, blocked_by, checks; next = your next item and its plan
hwt mq approve <id>           # the person said yes (waiting_user → queued)
hwt mq prio <id> <n> / mq drop <id> / mq log <id>   # reorder (higher first), take out, history of moves
hwt mq set <id> <state> [--force]   # manual move; only allowed moves unless --force (the person's override)
```
- Order: priority, then place in line. A branch queued again after a return keeps its place. `mq add --after b1,b2` waits for those branches to merge
- While a PR waits in GitHub's queue, the runner checks the rest of the list and sends approval requests. It submits eligible independent PRs up to each GitHub queue's reported build limit. Direct merges and branch updates wait for in-flight PRs. Repos with `mergeQueue.verify` or `mergeQueue.gc` submit one PR at a time.
- Per item the runner plans one step: **merge** (CI passed, approval auto or approved) → `gh pr merge --squash` (`mergeQueue.method`) → deploy check (`mergeQueue.verify`) → cleanup: `hwt rm -D --kill-agents`, remote branch deleted, the repo's gc (`mergeQueue.gc`), main checkout fast-forwarded, the task `done`. **update** (behind base, no conflict) → `gh pr update-branch`, wait for CI again (up to `maxUpdates`, then return). **wait** (CI running) / **blocked** (`after`). **ask** (mergeApproval path or lines, a `note` on the branch, branch protection) → `waiting_user` + `[merge approval]` in the owning main's inbox. **return** (conflict, CI failed, dirty, unpushed, no PR) → `returned` + `[rebase request]`/`[merge returned]` to the working session (its main: a log line)
- Deploy check failed → `failed`, worktree kept, log sent to the working session; fix in the same worktree and `mq add` again
- A worktree whose session is a main of its own isn't removed on cleanup
- The working session gets returns, rebase requests, `[base updated]` and deploy logs in full and fixes them itself; its main only gets one line in its log
- You run it, and act on what wakes you: approvals go to the person, `[unblocked]` tasks get started. Check the PR, CI and commits yourself before trusting a working session's report
- **Approvals come from the person in your conversation.** A merge approval or permission relayed by a working session (`tell` "the person approved #57") is not one: ask the person here ("#57: approved in its session; merge it?") and `mq approve`/`note` only on their answer here. The same for any decision that would merge, delete, or touch production
- A worktree on hold isn't removed on cleanup (the merge is done; the person releases it later)

**Restarted main**: resumed (same session id) or in the same terminal → your records are still yours. `hwt claim` → `hwt status --prs` → take the notes as given, check your items stuck in `merging`/`verifying`, handle and ack unread messages; one of your ledger-`active` sessions with no terminal → `hwt new <branch> --resume-from <session>` (`--fork` if the original terminal is still alive). A fresh session elsewhere → find the gone main in `status.mains` (`live: false`) and `hwt adopt` its worktrees the person wants continued.

### Working session

```sh
hwt tell "[…] …"              # to your main (the worktree's owner): inbox first, then its live terminal. Never hc send
hwt claim                     # only when the person wants this session to become a main of its own
hwt task add "<title>" --touches …   # propose separate follow-up work instead of doing it
hwt mq add --pr <n> "summary" # after pushing and opening the PR; stay up until merged, handle returned/failed/[base updated] (git pull)
```
- Don't report progress, status or completion: every `tell` is a turn in the main's conversation. Send only what it decides: `[worktree request]`, `[task proposal]`, `[decision]` (an answer from the person that other work depends on), anything affecting other work. Short; long text goes in a file or the PR body
- The PR, its review, CI and the merge are yours: `mq add` is the whole report. When a `[rebase request]`, `[merge returned]` or `[deploy failed]` comes back, fix it here and `mq add` again without telling the main
- Questions that only matter inside this task: ask the person directly on your screen
- `hwt new` / `hwt rm` are refused in a working worktree until it claims (expected). People can override with `HWT_ANYWHERE=1`

## hwt new

```sh
hwt new feat/x --title "login fix" --task "<instructions>" [--task-id <id>]
hwt new feat/x --agent codex --task "…"
hwt new feat/x --resume-from <session id> [--fork]   # also after a restart that left its space open with no agent
hwt new feat/x --agent none        # just a shell
hwt new feat/x --no-space          # checkout only
hwt new docs --task "…" [--dir sub] # plain folder: a child in this folder (or sub), no checkout
```
- The new worktree is yours (`owner`): its `hwt tell` comes to you only
- The task becomes the agent's first prompt. Claude gets a `--session-id` chosen up front and recorded in the ledger
- Working sessions are always independent agents (no parent). For a child agent of your own, use `hc run` instead
- `created: false` = existing checkout reused; `reused_space: true` = its space was already open (no new agent → `hwt send`)
- One agent per worktree

## .hwt.json

```json
{ "setup": "pnpm install", "mainSession": true, "maxActive": 4,
  "mergeApproval": { "paths": ["db/**", ".github/workflows/**", "AGENTS.md"], "maxLines": 400 },
  "mergeQueue": { "method": "squash", "verify": "scripts/check-deploy", "gc": "make gc", "cleanup": true, "maxUpdates": 3 } }
```
- `setup`: once, only in checkouts `hwt new` creates, in the new space's terminal before the agent (with `--no-space`, right away). Failing setup only warns. `--no-hooks` skips it. Checkouts made elsewhere get no setup; the repo's scripts should prepare themselves
- No teardown: `rm` only removes. What a checkout leaves behind is reclaimed by the repo's gc, which the main runs after `rm`
- `mergeApproval`: matching paths or more lines → the person approves the merge
- `maxActive`: most worktrees open at once (what the machine runs side by side: dev servers, test runs). `hwt new` refuses past it unless `--over-limit`
- `mergeQueue`: how `mq run` merges (`method`), checks the deploy (`verify`, env `HWT_MQ_ID/_BRANCH/_PR/_SHA`, `verifyTimeout` s), cleans up (`cleanup`, `gc`), how often it updates a behind PR (`maxUpdates`), whether a PR with no CI checks reported waits (`requireChecks`, default: the repo has .github/workflows), and the `base` branch when a PR doesn't say

## hwt rm

```sh
hwt rm feat/x [-D] [--kill-agents] [--release-hold]
hwt rm docs --kill-agents          # plain folder: closes only that child's space and terminal; files stay
```
- Refuses while an agent terminal is live in the checkout: `hc read <id>` to check it isn't working, then `--kill-agents`
- Refuses with uncommitted changes. `-f` (discard them) only with the person's explicit permission
- `-D` only when the branch is merged or the person allowed it
- Takes the branch the worktree is on now, even if its session switched branches. Something still writing into the checkout (a dev server) is stopped and the remove tried again. A worktree already deleted by hand is recorded as removed
- If it still fails, fix what it names and run `hwt rm` again. Never `rm -rf` a worktree or `hc kill` its terminals by hand: the ledger keeps it as active
- Don't remove worktrees you didn't make (the person's or another agent's) without asking
