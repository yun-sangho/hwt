#!/usr/bin/env bun
// hwt: git worktrees as Herdr spaces, and a ledger for running many coding agents in parallel.
import pkg from "../package.json" with { type: "json" };
import { cmdLs, cmdNew, cmdRm, cmdSend, cmdTitle } from "./commands/worktree.ts";
import { cmdAck, cmdClaim, cmdInbox, cmdMain, cmdNote, cmdStatus, cmdTell, cmdWait } from "./commands/session.ts";
import { cmdMq, cmdTask } from "./commands/queue.ts";
import { cmdDoctor, cmdHook, cmdInit, cmdShellInit } from "./commands/tools.ts";
import { HwtError } from "./util.ts";

const HELP = `hwt ${pkg.version}: git worktrees as Herdr spaces

Worktrees
  hwt new <branch> [--agent claude|codex|none|<cmd>] [--task TEXT] [--title T]
                   [--task-id ID] [--resume-from ID [--fork]] [--no-space] [--no-hooks]
  hwt rm [<branch>] [-f] [-D] [--kill-agents]
  hwt ls
  hwt send <worktree|branch> TEXT        hwt title <worktree|branch> TEXT

Main-session workflow ("mainSession": true in .hwt.json)
  hwt claim | main | status [--prs] | wait [--timeout S]
  hwt tell TEXT | inbox [--all] | ack <id>...|--all | note [--branch B] TEXT
  hwt task add TITLE [--touches p1,p2] [--detail T] | ls [--all] | decide <id> now|later|after:<branch> --why T | done|drop <id>
  hwt mq add [--pr N] [TEXT] | ls [--all] | next | set <id> <state> [--why T] | approve <id>

Setup
  hwt init [--main-session] [--setup CMD] [--lang en|ko]
  hwt doctor
  hwt shell-init zsh|bash|fish
  hwt hook session-start

stdout is JSON (status, ls-style lists pretty-printed); progress goes to stderr.
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "new": return cmdNew(args);
    case "rm": return cmdRm(args);
    case "ls": return cmdLs();
    case "send": return cmdSend(args);
    case "title": return cmdTitle(args);
    case "claim": return cmdClaim();
    case "main": return cmdMain();
    case "tell": return cmdTell(args);
    case "inbox": return cmdInbox(args);
    case "ack": return cmdAck(args);
    case "note": return cmdNote(args);
    case "status": return cmdStatus(args);
    case "wait": return cmdWait(args);
    case "task": return cmdTask(args);
    case "mq": return cmdMq(args);
    case "init": return cmdInit(args);
    case "doctor": return cmdDoctor();
    case "shell-init": return cmdShellInit(args);
    case "hook": return cmdHook(args);
    case "--version":
    case "-V":
      process.stdout.write(`${pkg.version}\n`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`hwt: unknown command ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof HwtError) {
    process.stderr.write(`hwt: ${e.message}\n`);
    process.exitCode = 1;
  } else throw e;
}
