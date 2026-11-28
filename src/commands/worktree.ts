// hwt new / rm / ls / send / title
import { existsSync, rmdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "../args.ts";
import { adapterFor } from "../agents.ts";
import { checkoutConfig, defaultAgent, langFor, mainConfig, worktreesRoot } from "../config.ts";
import { currentBranch, git, gitOut, isDirty, realpath, samePath, toplevel, worktreeList } from "../git.ts";
import { childKey, findChild, isGit, projectRoot } from "../project.ts";
import * as herdr from "../herdr.ts";
import { type Ledger, readLedger, updateLedger, type WorktreeRecord } from "../ledger.ts";
import { messages, selfCommand } from "../messages.ts";
import { claimMain, isMainSessionRepo, mainOnly, selfId } from "../session.ts";
import { basename, die, printJson, run, runOut, shQuote, shellWords, sleepMs, slug, stamp, warn } from "../util.ts";

const NEW_USAGE = "hwt new <branch|name> [--agent claude|codex|none|<cmd>] [--task TEXT] [--title T] [--task-id ID] [--verify CHECK]... [--hold REASON] [--resume-from ID [--fork]] [--dir D] [--no-space] [--no-hooks] [--over-limit]";

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
      opts: ["agent", "task", "title", "task-id", "resume-from", "dir", "hold", "verify"],
      flags: ["fork", "no-space", "no-hooks", "over-limit"],
      // Herdr starts every worktree agent on its own (no parent) and can't name a terminal; these are
      // accepted so old callers keep working. `hc run` is the way to get a child agent.
      ignored: { name: true, detach: false, attach: false },
    },
    NEW_USAGE,
  );
  const branch = a.pos[0];
  if (!branch || a.pos.length > 1) die(`usage: ${NEW_USAGE}`);
  const nospace = !!a.flag["no-space"];
  let task = a.opt.task ?? "";
  const taskId = a.opt["task-id"];
  // What must hold in production after the deploy: kept in the ledger (worktree, task), checked in [post-deploy check].
  const verify = a.opt.verify?.split("\n").map((s) => s.trim()).filter(Boolean) ?? [];

  const main = projectRoot();
  // In a git repo every child gets a worktree; in a plain folder it opens in the folder (or --dir), sharing it.
  const folder = !isGit(main);
  if (folder) {
    if (nospace) die("a plain folder has no checkout to make: a child here is its Herdr space (drop --no-space)");
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) die(`invalid child name: ${branch} (letters, digits, . _ / -)`);
  } else {
    if (a.opt.dir) die("--dir is for plain folders; in a git repo the child gets a worktree");
    if (!git(["check-ref-format", "--branch", branch]).ok) die(`invalid branch name: ${branch}`);
  }
  mainOnly(main, "new");
  if (!nospace && !herdr.herdrUp()) die("Herdr is not running (open it, or pass --no-space for the worktree only)");
  if (folder) {
    const w = readLedger(main).worktrees[branch];
    if (w?.state === "active") die(`child ${branch} exists (hwt send ${branch} …, or hwt rm ${branch} first)`);
  }

  // A short title of the work, shown next to the worktree name everywhere: --title, else the task's
  // title (--task-id), else the first line of --task.
  let title = a.opt.title ?? "";
  if (!title && taskId) title = readLedger(main).tasks?.find((t) => t.id === taskId)?.title ?? "";
  if (!title && task) title = (task.split("\n")[0] ?? "").slice(0, 40);

  const wt = folder ? realpath(resolve(a.opt.dir ?? main)) : join(worktreesRoot(), basename(main), slug(branch));
  if (folder && !existsSync(wt)) die(`no folder ${wt}`);
  let created = false;
  if (folder) {
    // Nothing to make: the child works in an existing folder.
  } else if (existsSync(wt)) {
    warn(`reusing ${wt}`);
  } else {
    // How many checkouts the machine can run side by side is the repo's call (.hwt.json maxActive).
    const max = mainConfig(main).maxActive ?? 0;
    if (max > 0 && !a.flag["over-limit"]) {
      const open = Object.entries(readLedger(main).worktrees).filter(
        ([, w]) => w.state === "active" && w.kind !== "folder" && !w.self_main && existsSync(w.path),
      );
      if (open.length >= max) {
        die(
          `${open.length} worktrees are open and this repo allows ${max} at once (.hwt.json maxActive): ` +
            `${open.map(([b]) => b).join(", ")}\n  queue it (hwt task decide <id> later --why "maxActive") until one is merged, ` +
            "or pass --over-limit if the person asked for it",
        );
      }
    }
    const exists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], main).ok;
    const add = exists ? ["worktree", "add", wt, branch] : ["worktree", "add", "-b", branch, wt, "HEAD"];
    if (!run(["git", ...add], { cwd: toplevel() ?? main, passthrough: true }).ok) die("git worktree add failed");
    created = true;
  }
  const setup = created && !a.flag["no-hooks"] ? (checkoutConfig(wt, main).setup ?? "") : "";
  // The main making it owns it: the working session reports to that main alone. Making a child makes the
  // caller a main if it wasn't one yet (a session that started before the hook could claim it, a plain folder).
  const l0 = readLedger(main);
  const owner = selfId(l0) || null;
  if (owner && !l0.mains[owner]) claimMain(main, childKey(main, l0) || null, owner);
  const base = { path: wt, branch, created, owner, ...(folder ? { kind: "folder" as const } : {}) };
  if (taskId) {
    updateLedger(main, (l) => {
      for (const t of l.tasks ?? []) {
        if (t.id === taskId) Object.assign(t, { state: "running", branch, owner: owner ?? t.owner ?? null, started: stamp(), ...(verify.length ? { verify } : {}) });
      }
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
        path: wt, title, terminal: null, name: null, session: null, task: task.slice(0, 600), owner, created: stamp(), state: "active",
        ...(a.opt.hold ? { hold: a.opt.hold } : {}),
        ...(verify.length ? { verify } : {}),
      };
    });
    printJson({ ...base, space: null, terminal: null, setup: st });
    return;
  }

  const agentLine = a.opt.agent ?? defaultAgent(main);
  const none = agentLine === "" || agentLine === "none";

  // Already open in a space. With its agent live (or no agent asked for), show it instead of making a second
  // one. A space with no live agent is one Herdr restored after a restart or whose agent exited: it is closed
  // and opened again with the agent, so `--resume-from` brings the session back. (A folder is shared: others'
  // spaces are there.)
  const open = folder ? [] : herdr.spacesIn(wt);
  if (open.length && (none || agentIn(wt))) {
    herdr.selectSpace(open[0]!);
    warn("already open, switched to its space");
    printJson({ ...base, space: open[0], terminal: null, reused_space: true });
    return;
  }
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
    // Working sessions report through `hwt tell`, which finds their main session and keeps an inbox copy.
    const msg = messages(langFor(main));
    if (task && verify.length) task += `\n\n${msg.verifyInTask(verify)}`;
    if (task && (isMainSessionRepo(main) || folder)) task += `\n\n${msg.workerInstructions(selfCommand())}`;
    if (task && folder) task += `\n${msg.folderChild(branch, wt)}`;
    if (task) argv.push(task);
  }
  // Herdr starts argv through the person's login shell (their PATH), so a plain sh is enough for setup.
  // No agent and no setup: no argv, and Herdr opens the person's own shell.
  if (setup) {
    argv = none
      ? ["sh", "-c", `${setupPrefix(setup)}exec "\${SHELL:-/bin/sh}" -l`]
      : ["sh", "-c", `${setupPrefix(setup)}exec "$@"`, "sh", ...argv];
  }
  // A folder child can't be told apart by its folder (it shares it): it carries its name and its project.
  if (folder) {
    const shell = ["sh", "-c", 'exec "${SHELL:-/bin/sh}" -l'];
    argv = ["env", `HWT_PROJECT=${main}`, `HWT_CHILD=${branch}`, ...(argv.length ? argv : shell)];
  }

  // Record the worktree before the agent starts: its first `hwt tell` may come within seconds. Reopened
  // (--resume-from, usually with no --task or --title), it keeps the title, task and age it had.
  updateLedger(main, (l) => {
    const prev = l.worktrees[branch]?.state === "active" ? l.worktrees[branch] : undefined;
    l.worktrees[branch] = {
      path: wt, title: title || prev?.title || "", agent: kind, terminal: null, name: null, session,
      task: task ? task.slice(0, 600) : (prev?.task ?? ""), owner: owner ?? prev?.owner ?? null,
      created: prev?.created ?? stamp(), state: "active",
      ...((a.opt.hold ?? prev?.hold) ? { hold: a.opt.hold ?? prev?.hold } : {}),
      ...((verify.length ? verify : prev?.verify)?.length ? { verify: verify.length ? verify : prev!.verify } : {}),
      ...(folder ? { kind: "folder" as const } : {}),
    };
  });
  // The space is named after the work and its tab after the worktree, so the sidebar shows
  // "<title> <branch>" and the Agents panel "<title> · <worktree>". Without a title, the tab gets the branch.
  const name = folder ? branch : basename(wt);
  // Only now that the agent can start (its session was found): the old space goes.
  if (open.length) {
    warn(`no live agent in ${basename(wt)}: closing its space (and any terminal left there) to open it again with the agent`);
    for (const id of open) herdr.closeSpace(id);
  }
  const spaceTitle = title || readLedger(main).worktrees[branch]?.title || "";
  const r = herdr.newSpace({ folder: wt, name: spaceTitle || undefined, tab: spaceTitle ? name : branch, argv, focus: false });
  if (!r.ok) die(`herdr-app space.new failed: ${r.error}`);
  const { space, tab, terminal } = r.value;
  // hc can't name a terminal after the fact: the worktree goes on a label (hwt tell and send read it).
  herdr.label(terminal, `hwt.worktree=${name}`);
  updateLedger(main, (l) => {
    const w = l.worktrees[branch];
    if (w) Object.assign(w, { terminal, name, space });
  });
  printJson({ ...base, space, tab, terminal, name, parent: null, setup: setup ? "in-space" : null, session });
}

const RM_USAGE = "hwt rm [<branch>|<path>] [-f] [-D] [--kill-agents] [--release-hold]";

export interface RmOptions {
  force?: boolean;
  deleteBranch?: boolean;
  killAgents?: boolean;
  /** Remove a worktree on hold (the person said its work can go). */
  releaseHold?: boolean;
}

/** Refuse to remove a worktree the person wants kept until they have looked at it. */
function refuseHeld(name: string, w: WorktreeRecord | undefined, o: RmOptions): void {
  if (w?.hold && !o.releaseHold) {
    die(`${name} is on hold: ${w.hold}\n  remove it only once the person says so (hwt hold --release ${name}, or rm --release-hold)`);
  }
}

export interface RmResult {
  removed: string;
  branch: string;
  branch_deleted: boolean;
  spaces_closed: number;
  terminals_killed: number;
  /** The checkout was already gone (deleted by hand): only git's and the ledger's records were cleared. */
  already_gone?: boolean;
  /** Processes still working in the checkout that were stopped so it could be removed. */
  processes_stopped?: number[];
}

/**
 * A folder child: close its own space and terminal, nothing on disk (the folder isn't its). Refuses while its
 * agent is live, like rm in a worktree, unless killAgents.
 */
function removeFolderChild(main: string, target: string | undefined, o: RmOptions): RmResult {
  const l = readLedger(main);
  const key = target ?? (childKey(main, l) || die("name the child to remove"));
  const hit = findChild(l, key) ?? die(`no child ${key}`);
  const [name, w] = hit;
  if (w.state !== "active") die(`child ${name} was already removed`);
  refuseHeld(name, w, o);
  const me = herdr.myTerminal();
  // From hc ls, not hc get: only the list says which program (agent) a terminal runs.
  const t = w.terminal ? herdr.terminals().find((x) => x.address === w.terminal) : undefined;
  const live = t && herdr.isLive(t) && t.address !== me ? t : null;
  if (live && herdr.isAgent(live) && !o.killAgents) {
    die(`${name}'s agent is live in ${live.address} (check it with hc read ${live.address}; pass --kill-agents to remove anyway)`);
  }
  let spaces = 0;
  if (w.space && herdr.spaces().some((x) => x.id === w.space)) {
    herdr.closeSpace(w.space);
    spaces = 1;
  }
  if (live) herdr.kill(live.address);
  updateLedger(main, (l2) => {
    const r = l2.worktrees[name];
    if (r) Object.assign(r, { state: "removed", removed: stamp() });
  });
  return { removed: w.path, branch: name, branch_deleted: false, spaces_closed: spaces, terminals_killed: live ? 1 : 0 };
}

/** Active ledger records of the worktree at <wt>, whatever branch it is on now. */
function recordsAt(l: Ledger, wt: string, branch: string): string[] {
  return Object.entries(l.worktrees)
    .filter(([k, w]) => w.state === "active" && (k === branch || samePath(w.path, wt) || w.path === wt))
    .map(([k]) => k);
}

/** Pids of processes whose working directory is <dir> or below it, except this hwt and the shells it runs in. */
function processesIn(dir: string): number[] {
  const out = runOut(["lsof", "-n", "-d", "cwd", "-F", "pn"]);
  if (!out) return [];
  const mine = new Set<number>();
  const parents = new Map<number, number>();
  for (const line of (runOut(["ps", "-A", "-o", "pid=,ppid="]) ?? "").split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p) parents.set(p, pp ?? 0);
  }
  for (let p = process.pid; p > 1 && !mine.has(p); p = parents.get(p) ?? 0) mine.add(p);
  const hits: number[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n") {
      const p = line.slice(1);
      if (pid && !mine.has(pid) && (p === dir || p.startsWith(dir + "/"))) hits.push(pid);
    }
  }
  return [...new Set(hits)];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * git worktree remove, and when it fails (a dev server still writing build output into the checkout: "Directory
 * not empty"), stop the processes still working in it and try once more. The checkout was checked clean (or the
 * caller passed -f), so what is left is theirs. Returns the pids it stopped.
 */
function removeCheckout(main: string, wt: string, force: boolean, killAgents: boolean): number[] {
  const remove = (f: boolean) => run(["git", "worktree", "remove", ...(f ? ["--force"] : []), wt], { cwd: main, passthrough: true }).ok;
  if (remove(force)) return [];
  const pids = processesIn(wt);
  // An agent started outside Herdr is no leftover: same rule as an agent terminal.
  const agents = pids.filter((p) => /^(claude|codex)$/.test(basename(runOut(["ps", "-o", "comm=", "-p", String(p)]) ?? "")));
  if (agents.length && !killAgents) {
    die(`git worktree remove failed for ${wt}, and agents are working in it: ${agents.join(" ")} (pass --kill-agents to stop them)`);
  }
  for (const p of pids) {
    try {
      process.kill(p, "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < 30 && pids.some(alive); i++) sleepMs(100);
  if (pids.length) warn(`stopped processes still working in ${wt}: ${pids.join(" ")}`);
  if (remove(true)) return pids;
  // git let go of it but the folder came back (something wrote into it again): the files are leftovers.
  if (existsSync(wt) && !worktreeList(main).some((w) => samePath(w.path, wt))) {
    try {
      rmSync(wt, { recursive: true, force: true });
      return pids;
    } catch (e) {
      die(`git let go of ${wt}, but what is left of it can't be deleted (${(e as Error).message})\n  ${BY_HAND}`);
    }
  }
  const left = processesIn(wt);
  die(
    `git worktree remove failed for ${wt}` +
      (left.length ? ` (still working in it: ${left.join(" ")}; see ps -p ${left.join(",")})` : "") +
      `\n  ${BY_HAND}`,
  );
}

const BY_HAND = "don't delete the folder by hand: fix what is in the way and run hwt rm again, so the ledger follows";

/** hwt rm without the guard and the printing: the merge queue runner cleans up through this too. */
export function removeWorktree(main: string, target: string | undefined, o: RmOptions = {}): RmResult {
  if (!isGit(main)) return removeFolderChild(main, target, o);
  let wt: string;
  let branch: string;
  const l0 = readLedger(main);
  if (!target) {
    wt = toplevel() ?? die("not in a checkout");
    branch = currentBranch();
    if (samePath(wt, main)) die("this is the main checkout; name a branch");
  } else if (existsSync(target) && !l0.worktrees[target]) {
    wt = realpath(target);
    branch = currentBranch(wt);
  } else {
    // The ledger's branch, a worktree name, or the branch a worktree is on now (its session may have switched).
    branch = target;
    wt =
      (l0.worktrees[target]?.state === "active" ? l0.worktrees[target]!.path : undefined) ??
      findChild(l0, target)?.[1].path ??
      worktreeList(main).find((w) => w.branch === target)?.path ??
      l0.worktrees[target]?.path ??
      join(worktreesRoot(), basename(main), slug(target));
    if (existsSync(wt)) branch = currentBranch(wt) || target;
  }
  const records = recordsAt(l0, wt, branch);
  for (const k of records) refuseHeld(k, l0.worktrees[k], o);
  const gone = !existsSync(wt);
  if (gone && !records.length) die(`no worktree at ${wt}`);
  if (samePath(wt, main)) die("refusing to remove the main checkout");
  if (!gone && !o.force && isDirty(wt)) die(`${wt} has uncommitted changes (pass -f to discard them)`);

  // An agent whose terminal sits in the checkout may still be working (its cwd stays where it started).
  // Killing it cuts its turn off mid-way, so refuse unless the caller checked it and passes --kill-agents.
  const me = herdr.myTerminal();
  const inside = () => herdr.terminals().filter((t) => herdr.isLive(t) && t.address !== me && herdr.inDir(t, wt));
  if (!o.killAgents) {
    const agents = inside().filter(herdr.isAgent);
    if (agents.length) {
      die(
        `agent terminals are live in ${wt} (check them with hc read <id>; pass --kill-agents to remove anyway):\n` +
          agents.map((t) => `  ${t.address} ${t.agent} ${herdr.statusWord(t) ?? "?"} ${t.cwd}`).join("\n"),
      );
    }
  }
  // There is no teardown: whatever the checkout leaves behind (databases, ports, dev servers) is the repo's
  // to reclaim with its own gc, run by the main session after rm.

  // Look up spaces first; close them last, since the caller may be running inside one. Other terminals in the
  // checkout go first: a dev server left running there keeps writing into it and makes the remove fail.
  const ids = herdr.spacesIn(wt);
  let killed = 0;
  for (const t of inside()) {
    herdr.kill(t.address);
    killed++;
  }
  process.chdir(main);
  let stopped: number[] = [];
  if (gone) {
    // Deleted by hand (or the remove got half way): forget it in git and in the ledger.
    git(["worktree", "prune"], main);
    warn(`${wt} is already gone; recording it as removed`);
  } else {
    stopped = removeCheckout(main, wt, !!o.force, !!o.killAgents);
  }
  try {
    rmdirSync(join(wt, "..")); // the repo's folder under the worktrees root, once empty
  } catch {}
  let deleted = false;
  if (o.deleteBranch && branch) deleted = run(["git", "branch", "-D", branch], { cwd: main, passthrough: true }).ok;
  for (const id of ids) herdr.closeSpace(id);
  // Terminals that showed up in the checkout meanwhile (a space Herdr hadn't shown yet, or one started by hand).
  for (const t of inside()) {
    herdr.kill(t.address);
    killed++;
  }
  updateLedger(main, (l) => {
    for (const k of new Set([...records, ...recordsAt(l, wt, branch)])) Object.assign(l.worktrees[k]!, { state: "removed", removed: stamp() });
  });
  return {
    removed: wt, branch, branch_deleted: deleted, spaces_closed: ids.length, terminals_killed: killed,
    ...(gone ? { already_gone: true } : {}), ...(stopped.length ? { processes_stopped: stopped } : {}),
  };
}

export function cmdRm(args: string[]): void {
  const a = parse(
    args,
    { flags: ["force", "delete-branch", "kill-agents", "release-hold"], alias: { "-f": "--force", "-D": "--delete-branch" }, ignored: { "no-hooks": false } },
    RM_USAGE,
  );
  const main = projectRoot();
  mainOnly(main, "rm");
  printJson(
    removeWorktree(main, a.pos[0], {
      force: a.flag.force, deleteBranch: a.flag["delete-branch"], killAgents: a.flag["kill-agents"], releaseHold: a.flag["release-hold"],
    }),
  );
}

const HOLD_USAGE = "hwt hold <worktree|branch> <reason> | hold --release <worktree|branch>";

/**
 * hwt hold <worktree> REASON: keep a worktree (and its session) until the person releases it, e.g. a guide or
 * research the person still has to read. rm refuses it and the merge queue's cleanup leaves it.
 */
export function cmdHold(args: string[]): void {
  const a = parse(args, { flags: ["release"] }, HOLD_USAGE);
  const [target, ...reason] = a.pos;
  if (!target || (!a.flag.release && !reason.length)) die(`usage: ${HOLD_USAGE}`);
  const main = projectRoot();
  mainOnly(main, "hold");
  const l = readLedger(main);
  const hit = findChild(l, target) ?? (isGit(main) ? Object.entries(l.worktrees).find(([, w]) => w.state === "active" && worktreeList(main).some((x) => x.branch === target && samePath(x.path, w.path))) ?? null : null);
  if (!hit || hit[1].state !== "active") die(`no active worktree ${target} in the ledger`);
  const [key] = hit;
  updateLedger(main, (x) => {
    const w = x.worktrees[key]!;
    if (a.flag.release) delete w.hold;
    else w.hold = reason.join(" ");
  });
  printJson({ worktree: key, hold: a.flag.release ? null : reason.join(" ") });
}

/** The live agent working in <wt>, if any. */
export function agentIn(wt: string): string | undefined {
  return herdr.terminals().find((t) => herdr.isLive(t) && herdr.isAgent(t) && herdr.inDir(t, wt))?.address;
}

export function cmdLs(): void {
  const main = projectRoot();
  if (isGit(main)) return void process.stdout.write((gitOut(["worktree", "list"], main) ?? "") + "\n");
  const kids = Object.entries(readLedger(main).worktrees).filter(([, w]) => w.state === "active");
  process.stdout.write(`${main}  (folder)\n` + kids.map(([k, w]) => `  ${k}  ${w.path}  ${w.terminal ?? "-"}${w.title ? `  ${w.title}` : ""}\n`).join(""));
}

/** hwt send <worktree|branch|path|name> TEXT: main → the live agent of that child, whatever its id is now. */
export function cmdSend(args: string[]): void {
  const [target, ...rest] = args;
  if (!target || !rest.length) die("usage: hwt send <worktree|branch|path|name> <text>");
  const main = projectRoot();
  const l = readLedger(main);
  const hit = findChild(l, target);
  let to: string | undefined;
  let label: string;
  let title = "";
  if (isGit(main)) {
    const wt = hit?.[1].path ?? (existsSync(target) && target.includes("/") ? realpath(target) : worktreePath(main, target));
    if (!existsSync(wt)) die(`no worktree for ${target}`);
    to = agentIn(wt);
    label = basename(wt);
    title = (hit?.[1] ?? l.worktrees[currentBranch(wt)] ?? Object.values(l.worktrees).find((w) => w.state === "active" && samePath(w.path, wt)))?.title ?? "";
  } else {
    const [name, w] = hit ?? die(`no child ${target}`);
    const t = w.terminal ? herdr.terminal(w.terminal) : null;
    to = t && herdr.isLive(t) ? t.address : undefined;
    label = name;
    title = w.title ?? "";
  }
  if (!to) die(`no live agent in ${label} (reopen it: hwt new <branch> --resume-from <session>)`);
  if (!herdr.send(to, rest.join(" "))) {
    die(`hc send ${to} failed (tried 3 times). It may still have arrived: check with hc read ${to} before sending it again`);
  }
  printJson({ worktree: label, title, terminal: to, sent: true });
}

/** hwt title <worktree|branch|name> TEXT: rename the work (ledger, and the Herdr space of that child). */
export function cmdTitle(args: string[]): void {
  const [target, ...rest] = args;
  if (!target || !rest.length) die("usage: hwt title <worktree|branch|name> <text>");
  const main = projectRoot();
  const text = rest.join(" ");
  const hit = findChild(readLedger(main), target);
  let key: string;
  let spaces: string[];
  if (isGit(main)) {
    const wt = hit?.[1].path ?? worktreePath(main, target);
    if (!existsSync(wt)) die(`no worktree for ${target}`);
    key = currentBranch(wt);
    spaces = herdr.spacesIn(wt);
  } else {
    const [name, w] = hit ?? die(`no child ${target}`);
    key = name;
    spaces = w.space ? [w.space] : [];
  }
  updateLedger(main, (l) => {
    const w = l.worktrees[key];
    if (w) w.title = text;
  });
  for (const id of spaces) herdr.renameSpace(id, text);
  printJson({ worktree: hit ? (isGit(main) ? basename(hit[1].path) : hit[0]) : target, title: text });
}

export { mainConfig };
