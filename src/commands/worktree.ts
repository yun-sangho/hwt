// hwt new / rm / ls / send / title
import { existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../args.ts";
import { adapterFor } from "../agents.ts";
import { checkoutConfig, defaultAgent, langFor, mainConfig, worktreesRoot } from "../config.ts";
import { currentBranch, git, gitOut, isDirty, realpath, repoMain, samePath, toplevel } from "../git.ts";
import * as herdr from "../herdr.ts";
import { readLedger, updateLedger } from "../ledger.ts";
import { messages, selfCommand } from "../messages.ts";
import { claimMain, isMainSessionRepo, mainOnly } from "../session.ts";
import { basename, die, printJson, run, shQuote, shellWords, slug, stamp, warn } from "../util.ts";

const NEW_USAGE = "hwt new <branch> [--agent claude|codex|none|<cmd>] [--task TEXT] [--title T] [--task-id ID] [--resume-from ID [--fork]] [--no-space] [--no-hooks]";

export function worktreePath(main: string, branchOrName: string): string {
  const base = join(worktreesRoot(), basename(main));
  const direct = join(base, branchOrName);
  return existsSync(direct) && !branchOrName.includes("/") ? direct : join(base, slug(branchOrName));
}

/** Setup runs in the space's own terminal (POSIX sh), in view, before the agent or shell takes over. */
function setupPrefix(setup: string): string {
  return `echo ${shQuote(`hwt: setup: ${setup}`)}\n{\n${setup}\n} || echo 'hwt: setup failed; carrying on' >&2\n`;
}

export function cmdNew(args: string[]): void {
  const a = parse(
    args,
    {
      opts: ["agent", "task", "title", "task-id", "resume-from"],
      flags: ["fork", "no-space", "no-hooks"],
      // Herdr starts every worktree agent on its own (no parent) and can't name a terminal; these are
      // accepted so old callers keep working. `hc run` is the way to get a child agent.
      ignored: { name: true, detach: false, attach: false },
    },
    NEW_USAGE,
  );
  const branch = a.pos[0];
  if (!branch || a.pos.length > 1) die(`usage: ${NEW_USAGE}`);
  if (!git(["check-ref-format", "--branch", branch]).ok) die(`invalid branch name: ${branch}`);
  const nospace = !!a.flag["no-space"];
  let task = a.opt.task ?? "";
  const taskId = a.opt["task-id"];

  const main = repoMain();
  mainOnly(main, "new");
  if (!nospace && !herdr.herdrUp()) die("Herdr is not running (open it, or pass --no-space for the worktree only)");
  claimMain(main);

  // A short title of the work, shown next to the worktree name everywhere: --title, else the task's
  // title (--task-id), else the first line of --task.
  let title = a.opt.title ?? "";
  if (!title && taskId) title = readLedger(main).tasks?.find((t) => t.id === taskId)?.title ?? "";
  if (!title && task) title = (task.split("\n")[0] ?? "").slice(0, 40);

  const wt = join(worktreesRoot(), basename(main), slug(branch));
  let created = false;
  if (existsSync(wt)) {
    warn(`reusing ${wt}`);
  } else {
    const exists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], main).ok;
    const add = exists ? ["worktree", "add", wt, branch] : ["worktree", "add", "-b", branch, wt, "HEAD"];
    if (!run(["git", ...add], { cwd: toplevel() ?? main, passthrough: true }).ok) die("git worktree add failed");
    created = true;
  }
  const setup = created && !a.flag["no-hooks"] ? (checkoutConfig(wt, main).setup ?? "") : "";
  const base = { path: wt, branch, created };
  if (taskId) {
    updateLedger(main, (l) => {
      for (const t of l.tasks ?? []) if (t.id === taskId) Object.assign(t, { state: "running", branch, started: stamp() });
    });
  }

  if (nospace) {
    let st: string | null = null;
    if (setup) {
      warn(`setup: ${setup}`);
      st = run(["sh", "-c", setup], { cwd: wt, passthrough: true }).ok ? "ok" : "failed";
      if (st === "failed") warn("setup failed; carrying on");
    }
    updateLedger(main, (l) => {
      l.worktrees[branch] = {
        path: wt, title, terminal: null, name: null, session: null, task: task.slice(0, 600), created: stamp(), state: "active",
      };
    });
    printJson({ ...base, space: null, terminal: null, setup: st });
    return;
  }

  // Already open in a space: show it instead of making a second one.
  const open = herdr.spacesIn(wt)[0];
  if (open) {
    herdr.selectSpace(open);
    warn("already open, switched to its space");
    printJson({ ...base, space: open, terminal: null, reused_space: true });
    return;
  }

  const agentLine = a.opt.agent ?? defaultAgent(main);
  const none = agentLine === "" || agentLine === "none";
  let argv: string[] = [];
  let session: string | null = null;
  let kind = "none";
  if (!none) {
    const words = shellWords(agentLine);
    const adapter = adapterFor(words);
    kind = adapter.kind;
    const plan = adapter.plan(words, { worktree: wt, resume: a.opt["resume-from"], fork: !!a.flag.fork });
    argv = plan.argv;
    session = plan.session;
    // Working sessions report through `hwt tell`, which finds the main session and keeps an inbox copy.
    if (task && isMainSessionRepo(main)) task += `\n\n${messages(langFor(main)).workerInstructions(selfCommand())}`;
    if (task) argv.push(task);
  }
  // Herdr starts argv through the person's login shell (their PATH), so a plain sh is enough for setup.
  // No agent and no setup: no argv, and Herdr opens the person's own shell.
  if (setup) {
    argv = none
      ? ["sh", "-c", `${setupPrefix(setup)}exec "\${SHELL:-/bin/sh}" -l`]
      : ["sh", "-c", `${setupPrefix(setup)}exec "$@"`, "sh", ...argv];
  }

  // Record the worktree before the agent starts: its first `hwt tell` may come within seconds.
  updateLedger(main, (l) => {
    l.worktrees[branch] = {
      path: wt, title, agent: kind, terminal: null, name: null, session, task: task.slice(0, 600), created: stamp(), state: "active",
    };
  });
  // The space is named after the work and its tab after the worktree, so the sidebar shows
  // "<title> <branch>" and the Agents panel "<title> · <worktree>". Without a title, the tab gets the branch.
  const r = herdr.newSpace({ folder: wt, name: title || undefined, tab: title ? basename(wt) : branch, argv, focus: false });
  if (!r.ok) die(`herdr-app space.new failed: ${r.error}`);
  const { space, tab, terminal } = r.value;
  // hc can't name a terminal after the fact: the worktree goes on a label (hwt tell and send read it).
  herdr.label(terminal, `hwt.worktree=${basename(wt)}`);
  updateLedger(main, (l) => {
    const w = l.worktrees[branch];
    if (w) Object.assign(w, { terminal, name: basename(wt) });
  });
  printJson({ ...base, space, tab, terminal, name: basename(wt), parent: null, setup: setup ? "in-space" : null, session });
}

const RM_USAGE = "hwt rm [<branch>|<path>] [-f] [-D] [--kill-agents]";

export function cmdRm(args: string[]): void {
  const a = parse(
    args,
    { flags: ["force", "delete-branch", "kill-agents"], alias: { "-f": "--force", "-D": "--delete-branch" }, ignored: { "no-hooks": false } },
    RM_USAGE,
  );
  const target = a.pos[0];
  const main = repoMain();
  mainOnly(main, "rm");
  claimMain(main);
  let wt: string;
  let branch: string;
  if (!target) {
    wt = toplevel() ?? die("not in a checkout");
    branch = currentBranch();
    if (samePath(wt, main)) die("this is the main checkout; name a branch");
  } else if (existsSync(target)) {
    wt = realpath(target);
    branch = currentBranch(wt);
  } else {
    branch = target;
    wt = join(worktreesRoot(), basename(main), slug(target));
  }
  if (!existsSync(wt)) die(`no worktree at ${wt}`);
  if (samePath(wt, main)) die("refusing to remove the main checkout");
  if (!a.flag.force && isDirty(wt)) die(`${wt} has uncommitted changes (pass -f to discard them)`);

  // An agent whose terminal sits in the checkout may still be working (its cwd stays where it started).
  // Killing it cuts its turn off mid-way, so refuse unless the caller checked it and passes --kill-agents.
  const me = herdr.myTerminal();
  const inside = herdr.terminals().filter((t) => herdr.isLive(t) && t.address !== me && herdr.inDir(t, wt));
  if (!a.flag["kill-agents"]) {
    const agents = inside.filter(herdr.isAgent);
    if (agents.length) {
      die(
        `agent terminals are live in ${wt} (check them with hc read <id>; pass --kill-agents to remove anyway):\n` +
          agents.map((t) => `  ${t.address} ${t.agent} ${herdr.statusWord(t) ?? "?"} ${t.cwd}`).join("\n"),
      );
    }
  }
  // There is no teardown: whatever the checkout leaves behind (databases, ports, dev servers) is the repo's
  // to reclaim with its own gc, run by the main session after rm.

  // Look up spaces first; close them last, since the caller may be running inside one.
  const ids = herdr.spacesIn(wt);
  process.chdir(main);
  if (!run(["git", "worktree", "remove", ...(a.flag.force ? ["--force"] : []), wt], { cwd: main, passthrough: true }).ok) {
    die("git worktree remove failed");
  }
  try {
    rmdirSync(join(wt, "..")); // the repo's folder under the worktrees root, once empty
  } catch {}
  let deleted = false;
  if (a.flag["delete-branch"] && branch) deleted = run(["git", "branch", "-D", branch], { cwd: main, passthrough: true }).ok;
  for (const id of ids) herdr.closeSpace(id);
  // Terminals still sitting in the checkout (a space Herdr hadn't shown yet, or one started by hand).
  const left = herdr.terminals().filter((t) => herdr.isLive(t) && t.address !== me && herdr.inDir(t, wt));
  for (const t of left) herdr.kill(t.address);
  updateLedger(main, (l) => {
    const w = l.worktrees[branch];
    if (w) Object.assign(w, { state: "removed", removed: stamp() });
  });
  printJson({ removed: wt, branch, branch_deleted: deleted, spaces_closed: ids.length, terminals_killed: left.length });
}

export function cmdLs(): void {
  process.stdout.write((gitOut(["worktree", "list"], repoMain()) ?? "") + "\n");
}

/** hwt send <worktree|branch|path> TEXT: main → the live agent working in that worktree, whatever its id is now. */
export function cmdSend(args: string[]): void {
  const [target, ...rest] = args;
  if (!target || !rest.length) die("usage: hwt send <worktree|branch|path> <text>");
  const main = repoMain();
  const wt = existsSync(target) && target.includes("/") ? realpath(target) : worktreePath(main, target);
  if (!existsSync(wt)) die(`no worktree for ${target}`);
  const to = herdr.terminals().find((t) => herdr.isLive(t) && herdr.isAgent(t) && herdr.inDir(t, wt))?.address;
  if (!to) die(`no live agent in ${basename(wt)} (reopen it: hwt new <branch> --resume-from <session>)`);
  if (!herdr.send(to, rest.join(" "))) die(`hc send ${to} failed`);
  const b = currentBranch(wt);
  printJson({ worktree: basename(wt), title: readLedger(main).worktrees[b]?.title ?? "", terminal: to, sent: true });
}

/** hwt title <worktree|branch> TEXT: rename the work (ledger, and the Herdr space of that worktree). */
export function cmdTitle(args: string[]): void {
  const [target, ...rest] = args;
  if (!target || !rest.length) die("usage: hwt title <worktree|branch> <text>");
  const main = repoMain();
  const wt = worktreePath(main, target);
  if (!existsSync(wt)) die(`no worktree for ${target}`);
  const b = currentBranch(wt);
  const text = rest.join(" ");
  updateLedger(main, (l) => {
    const w = l.worktrees[b];
    if (w) w.title = text;
  });
  for (const id of herdr.spacesIn(wt)) herdr.renameSpace(id, text);
  printJson({ worktree: basename(wt), title: text });
}

export { mainConfig };
