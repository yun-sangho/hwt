// hwt task … (ledger.tasks) and hwt mq … (ledger.merges)
import { existsSync } from "node:fs";
import { parse } from "../args.ts";
import { langFor } from "../config.ts";
import { currentBranch, samePath, toplevel, touchedPaths } from "../git.ts";
import { childKey, isGit, projectRoot, requireGit } from "../project.ts";
import * as herdr from "../herdr.ts";
import { readLedger, updateLedger, type MergeState } from "../ledger.ts";
import { messages } from "../messages.ts";
import { basename, die, printJson, shortId, stamp } from "../util.ts";
import { tell } from "./session.ts";
import { removeWorktree } from "./worktree.ts";
import {
  blockedBy, checkList, IN_FLIGHT, leaseLive, move, mqChecks, nextSeq, OPEN, ordered, previewQueue, runQueue, STATES, WAITING, type PreviewEntry,
} from "../mq.ts";
import type { Merge } from "../ledger.ts";
import { actsAsMain, notifyMain, ownerOf, owns, selfId } from "../session.ts";
import { daemonLog, installService, liveDaemon, runDaemon, serviceInstalled, uninstallService } from "../daemon.ts";
import { knownRepos } from "../repos.ts";

// ---- Tasks ------------------------------------------------------------------------------
// Anyone may add (the person via a main session, or a working session that found more work); a task belongs
// to the main that added it, or to the proposing worktree's main. Only that main decides (now / later /
// after:<branch>) and starts it (hwt new --task-id). `ls` shows this main's tasks; overlaps are checked against
// every running worktree, whichever main it belongs to.

const TASK_USAGE = "hwt task add|ls [--all] [--every-main]|decide|done|drop";

export function cmdTask(args: string[]): void {
  const [sub = "ls", ...rest] = args;
  switch (sub) {
    case "--help":
    case "-h":
      return void process.stdout.write(`usage: ${TASK_USAGE}\n`);
    case "add": {
      const a = parse(rest, { opts: ["touches", "detail"] }, "hwt task add <title> [--touches p1,p2] [--detail TEXT]");
      const main = projectRoot();
      const title = a.pos.join(" ");
      if (!title) die("usage: hwt task add <title> [--touches p1,p2] [--detail TEXT]");
      const touches = a.opt.touches ?? "";
      const id = shortId("T");
      const asMain = actsAsMain(main);
      const from = asMain ? "user" : childKey(main, readLedger(main)) || currentBranch();
      updateLedger(main, (l) => {
        const owner = (asMain ? selfId(l) : ownerOf(l, from)) || null;
        l.tasks = [
          ...(l.tasks ?? []),
          {
            id, title, detail: a.opt.detail ?? "", touches: touches.split(",").filter(Boolean), from, owner, added: stamp(),
            state: "queued", decision: null, why: null, branch: null,
          },
        ];
      });
      // From a working session: also put it in front of the main session.
      if (from !== "user") tell(messages(langFor(main)).taskProposal(id, title, touches));
      return printJson({ task: id, from, state: "queued" });
    }
    case "ls": {
      const main = projectRoot();
      const all = rest.includes("--all");
      const everyone = rest.includes("--every-main");
      const l = readLedger(main);
      const me = selfId(l);
      // Overlaps come from git (what each worktree changed); a folder has none to compare.
      const active = Object.entries(l.worktrees)
        .filter(([, w]) => isGit(main) && w.state === "active" && w.kind !== "folder" && existsSync(w.path))
        .flatMap(([b, w]) => touchedPaths(w.path, main).map((path) => ({ branch: b, path })));
      return printJson(
        (l.tasks ?? [])
          .filter((t) => all || ["queued", "decided", "running"].includes(t.state))
          .filter((t) => everyone || owns(me, t.owner))
          .map((t) => ({
            ...t,
            overlaps: [...new Set(t.touches.flatMap((p) => active.filter((x) => x.path.startsWith(p)).map((x) => x.branch)))],
          })),
        true,
      );
    }
    case "decide": {
      const a = parse(rest, { opts: ["why"] }, "hwt task decide <id> now|later|after:<branch> --why TEXT");
      const main = projectRoot();
      const [id, d] = a.pos;
      if (!id || !d) die("usage: hwt task decide <id> now|later|after:<branch> --why TEXT");
      if (!(d === "now" || d === "later" || d.startsWith("after:"))) die("decision is now, later or after:<branch>");
      const known = updateLedger(main, (l) => {
        for (const t of l.tasks ?? []) {
          if (t.id === id) Object.assign(t, { state: "decided", decision: d, why: a.opt.why ?? "", decided: stamp() });
        }
      }).tasks?.some((t) => t.id === id);
      if (!known) die(`no task ${id}`);
      return;
    }
    case "done":
    case "drop": {
      const a = parse(rest, { opts: ["why"] }, `hwt task ${sub} <id> [--why TEXT]`);
      const main = projectRoot();
      const id = a.pos[0] ?? die(`usage: hwt task ${sub} <id> [--why TEXT]`);
      const known = updateLedger(main, (l) => {
        for (const t of l.tasks ?? []) {
          if (t.id === id) {
            Object.assign(t, { state: sub === "drop" ? "dropped" : "done", closed: stamp() });
            if (a.opt.why) t.why = a.opt.why;
          }
        }
      }).tasks?.some((t) => t.id === id);
      if (!known) die(`no task ${id}`);
      return;
    }
    default:
      die(`usage: ${TASK_USAGE}`);
  }
}

// ---- Merge queue --------------------------------------------------------------------------
// The queue itself (order, states, checks, plan, runner) is in mq.ts. Working sessions ask (`hwt mq add`) and
// stay up for fixes; a main runs `hwt mq run`, which merges one item at a time for the repo, whichever main
// owns it, and takes each through the deploy check and cleanup before the next.

const MQ_USAGE = `hwt mq add [--pr N] [--after b1,b2] [--priority N] [TEXT]
       mq ls [--all] | next | log <id>
       mq run [--watch] [--interval S] [--timeout S] [--dry-run]
       mq daemon [--interval S] [--once] | daemon status | daemon install [--interval S] | daemon uninstall
       mq approve <id> [--why T] | edit <id> [--verify C]... [--post-deploy C]... | drop <id> [--why T] | prio <id> <n> | set <id> <state> [--why T] [--force]
       mq release [id] [--result T] | problem [id] TEXT   (a working session's answer to [post-deploy check])`;

/** Find item <id>, change it under the ledger lock, or die when there is none. */
function withItem(main: string, id: string, change: (m: Merge) => void): Merge {
  let found: Merge | undefined;
  updateLedger(main, (l) => {
    found = (l.merges ?? []).find((m) => m.id === id);
    if (found) change(found);
  });
  return found ?? die(`no merge request ${id}`);
}

export function cmdMq(args: string[]): void {
  const [sub = "ls", ...rest] = args;
  const help = [sub, ...rest].some((x) => x === "--help" || x === "-h");
  if (sub === "daemon" && !help) return cmdDaemon(rest);
  if (!help) requireGit(projectRoot(), "the merge queue");
  switch (sub) {
    case "--help":
    case "-h":
      return void process.stdout.write(`usage: ${MQ_USAGE}\n`);
    case "add": {
      const a = parse(rest, { opts: ["pr", "after", "priority", "post-deploy"] }, "hwt mq add [--pr N] [--after b1,b2] [--priority N] [--post-deploy CHECK]... [TEXT]");
      const main = projectRoot();
      const text = a.pos.join(" ");
      const pr = a.opt.pr ? Number(a.opt.pr) : null;
      if (a.opt.pr && !Number.isInteger(pr)) die(`--pr needs a number: ${a.opt.pr}`);
      const priority = a.opt.priority !== undefined ? Number(a.opt.priority) : undefined;
      if (priority !== undefined && !Number.isInteger(priority)) die(`--priority needs a whole number: ${a.opt.priority}`);
      const here = toplevel();
      if (!here || samePath(here, main)) die("mq add runs in the working worktree (it queues that branch)");
      const b = currentBranch();
      const initialId = shortId("M");
      let id = initialId;
      let kept: number | undefined;
      updateLedger(main, (l) => {
        const merges = l.merges ?? [];
        const flying = merges.find((m) => m.branch === b && IN_FLIGHT.includes(m.state));
        if (flying) die(`${b} is ${flying.state} (${flying.id}); wait for it`);
        const checking = merges.find((m) => m.branch === b && m.state === "checking");
        if (checking) die(`${b} is deployed and waits for its post-deploy check (${checking.id}): hwt mq release ${checking.id} --result "…" or hwt mq problem ${checking.id} "…" first`);
        for (let suffix = 2; merges.some((m) => m.id === id); suffix++) id = `${initialId}-${suffix}`;
        // A branch queued again (after a return or failure) keeps its place in line, and replaces the old request.
        const old = merges.filter((m) => m.branch === b && [...WAITING, "returned", "failed"].includes(m.state));
        kept = old.map((m) => m.seq).find((x) => x !== undefined);
        const prev = old[0];
        // The main's criteria come from the worktree (hwt new --verify) or its task; the working session only adds.
        const w = l.worktrees[b];
        const verify = w?.verify ?? (l.tasks ?? []).find((t) => t.branch === b && t.verify?.length)?.verify ?? prev?.verify;
        const post = a.opt["post-deploy"]?.split("\n").map((s) => s.trim()).filter(Boolean) ?? prev?.post_deploy;
        const item: Merge = {
          id, branch: b, pr, path: here, from: herdr.myTerminal(), note: text, requested: stamp(), state: "queued", why: null,
          seq: kept ?? nextSeq(l),
          priority: priority ?? prev?.priority ?? 0,
          after: a.opt.after ? a.opt.after.split(",").filter(Boolean) : (prev?.after ?? []),
          updates: 0,
          ...(verify?.length ? { verify } : {}),
          ...(post?.length ? { post_deploy: post } : {}),
          history: [{ at: stamp(), from: null, to: "queued", by: herdr.myTerminal() || b, why: old.length ? `again (was ${old.map((m) => m.id).join(", ")})` : null }],
        };
        for (const m of old) move(m, "dropped", b, `replaced by ${id}`, true);
        l.merges = [...merges, item];
        if (w && pr) w.pr = pr;
      });
      // The sidebar shows the PR: its space becomes "pr-<n> <title>".
      if (pr) {
        const w = readLedger(main).worktrees[b];
        for (const s of herdr.spacesIn(here)) herdr.renameSpace(s, herdr.spaceName(w?.title || basename(here), pr));
      }
      // A log entry: the runner takes it from the queue; the main hears of it, marked as needing nothing.
      tell(`${messages(langFor(main)).tags.mergeRequest} ${id} ${b}${pr ? ` PR #${pr}` : ""}${text ? ` — ${text}` : ""}`, { wake: false });
      const queued = (readLedger(main).merges ?? []).find((m) => m.id === id);
      return printJson({
        merge: id, branch: b, state: "queued", place_kept: kept !== undefined,
        ...(queued && checkList(queued) ? { after_deploy: checkList(queued) } : {}),
        runner: liveDaemon() ? "daemon" : "main (hwt mq run)",
        next: "end your turn: don't wait for or poll CI, the merge or the deploy; the queue messages you if there is something to fix",
      });
    }
    case "ls": {
      const main = projectRoot();
      const all = rest[0] === "--all";
      const l = readLedger(main);
      const me = selfId(l);
      const items = ordered(l)
        .filter((m) => all || OPEN.includes(m.state))
        .map((m, i) => {
          const owner = ownerOf(l, m.branch);
          const { history, ...rest } = m;
          return {
            place: WAITING.includes(m.state) ? i + 1 : null,
            ...rest, owner, mine: owns(me, owner), blocked_by: blockedBy(l, m), events: history?.length ?? 0,
            title: l.worktrees[m.branch]?.title ?? "",
            checks: mqChecks(main, m, l),
          };
        });
      return printJson(items, true);
    }
    case "next": {
      // What `mq run` would do next for this main, without doing it.
      const main = projectRoot();
      const l = readLedger(main);
      const me = selfId(l);
      const lease = leaseLive(l.mq?.lease) ? l.mq!.lease : null;
      const busy = ordered(l).find((m) => IN_FLIGHT.includes(m.state));
      let planned: PreviewEntry | undefined;
      for (const item of previewQueue(main, l)) {
        if (item.state !== "queued" && item.state !== "updating") continue;
        if (!owns(me, ownerOf(l, item.branch))) continue;
        planned ??= item;
        if (item.step.act === "wait" || item.step.act === "blocked") continue;
        planned = item;
        break;
      }
      const next = l.merges?.find((m) => m.id === planned?.id);
      const checks = planned?.checks;
      return printJson(
        {
          ...(busy ? { busy } : {}),
          next: next && planned && checks
            ? { ...next, checks, plan: planned.step, may_merge: checks.approval === "auto" || next.approved != null }
            : null,
          waiting_user: ordered(l)
            .filter((m) => m.state === "waiting_user" && owns(me, ownerOf(l, m.branch)))
            .map((m) => ({ id: m.id, branch: m.branch, why: m.why ?? mqChecks(main, m, l).approval_why.join("; ") })),
          runner: lease,
        },
        true,
      );
    }
    case "run": {
      const a = parse(rest, { opts: ["interval", "timeout"], flags: ["watch", "dry-run"] }, "hwt mq run [--watch] [--interval S] [--timeout S] [--dry-run]");
      const main = projectRoot();
      if (!a.flag["dry-run"] && !actsAsMain(main)) die("mq run is a main session's (a working session asks with hwt mq add)");
      const by = selfId(readLedger(main)) || "runner";
      const d = liveDaemon();
      if (d && !a.flag["dry-run"]) process.stderr.write(`hwt: note: the merge-queue daemon is running (pid ${d.pid}); it drains this queue too\n`);
      const report = runQueue(main, {
        watch: !!a.flag.watch,
        interval: Number(a.opt.interval ?? 30),
        timeout: Number(a.opt.timeout ?? 3600),
        dryRun: !!a.flag["dry-run"],
        by,
        remove: (branch) => void removeWorktree(main, branch, { deleteBranch: true, killAgents: true }),
      });
      return printJson(report, true);
    }
    case "log": {
      const main = projectRoot();
      const id = rest[0] ?? die("usage: hwt mq log <id>");
      const m = (readLedger(main).merges ?? []).find((x) => x.id === id) ?? die(`no merge request ${id}`);
      return printJson({ id: m.id, branch: m.branch, pr: m.pr, state: m.state, history: m.history ?? [] }, true);
    }
    case "approve": {
      const a = parse(rest, { opts: ["why"] }, "hwt mq approve <id> [--why TEXT]");
      const main = projectRoot();
      const id = a.pos[0] ?? die("usage: hwt mq approve <id> [--why TEXT]");
      const by = selfId(readLedger(main)) || "user";
      const item = withItem(main, id, (m) => {
        Object.assign(m, { approved: stamp(), approved_why: a.opt.why ?? "" });
        if (m.state === "waiting_user") move(m, "queued", by, `approved${a.opt.why ? `: ${a.opt.why}` : ""}`);
      });
      // The main goes on with its work: the runner merges, and the result comes to it as a message.
      return printJson({
        approved: id, branch: item.branch, state: item.state,
        runner: liveDaemon() ? "daemon" : "none: run hwt mq run --watch in the background",
        next: "don't wait or poll for the merge; [merged], [deploy failed] or [merge returned] comes to you",
      });
    }
    case "release":
    case "problem": {
      // The working session's answer to [post-deploy check]. The id defaults to this branch's item in checking.
      const usage = sub === "release" ? "hwt mq release [id] [--result TEXT]" : "hwt mq problem [id] TEXT";
      const a = parse(rest, { opts: ["result"] }, usage);
      const main = projectRoot();
      const l = readLedger(main);
      let id = a.pos[0] && /^M\d/.test(a.pos[0]) && l.merges?.some((m) => m.id === a.pos[0]) ? a.pos.shift()! : undefined;
      id ??= (l.merges ?? []).find((m) => m.state === "checking" && m.branch === currentBranch())?.id;
      if (!id) die(`no merge request in checking here; usage: ${usage}`);
      const text = sub === "release" ? (a.opt.result ?? a.pos.join(" ")) : a.pos.join(" ");
      if (sub === "problem" && !text) die(`say what is wrong; usage: ${usage}`);
      const by = herdr.myTerminal() || selfId(l) || "user";
      const item = withItem(main, id, (m) => {
        if (m.state !== "checking") die(`${id} is ${m.state}, not checking`);
        if (sub === "release") Object.assign(m, { released: stamp(), check_result: text });
        else {
          m.check_result = text;
          move(m, "failed", by, `post-deploy check: ${text}`);
        }
      });
      if (sub === "problem") {
        const owner = ownerOf(readLedger(main), item.branch);
        const msg = `${messages(langFor(main)).tags.postDeployProblem} ${id} ${item.branch}${item.pr ? ` PR #${item.pr}` : ""}: ${text} ` +
          `(the worktree stays; decide with the person whether to revert; the working session fixes it in a new PR)`;
        if (owner) notifyMain(main, owner, { branch: item.branch, path: item.path, text: msg, wake: true });
        return printJson({ problem: id, branch: item.branch, state: "failed", next: "the main decides about a revert; fix it here in a new PR (push, PR, mq add), then end your turn" });
      }
      return printJson({ released: id, branch: item.branch, next: "end your turn: the queue cleans up this worktree and tells the main [merged]" });
    }
    case "edit": {
      // The main changes what is checked after the deploy (say while approving): the lists are replaced.
      const a = parse(rest, { opts: ["verify", "post-deploy"] }, "hwt mq edit <id> [--verify CHECK]... [--post-deploy CHECK]...");
      const main = projectRoot();
      if (!actsAsMain(main)) die("mq edit is a main session's (a working session adds checks with mq add --post-deploy)");
      const id = a.pos[0] ?? die("usage: hwt mq edit <id> [--verify CHECK]... [--post-deploy CHECK]...");
      const list = (v: string | undefined) => v?.split("\n").map((s) => s.trim()).filter(Boolean);
      const item = withItem(main, id, (m) => {
        if (a.opt.verify !== undefined) m.verify = list(a.opt.verify);
        if (a.opt["post-deploy"] !== undefined) m.post_deploy = list(a.opt["post-deploy"]);
      });
      return printJson({ id, branch: item.branch, verify: item.verify ?? [], post_deploy: item.post_deploy ?? [] });
    }
    case "drop": {
      const a = parse(rest, { opts: ["why"] }, "hwt mq drop <id> [--why TEXT]");
      const main = projectRoot();
      const id = a.pos[0] ?? die("usage: hwt mq drop <id> [--why TEXT]");
      withItem(main, id, (m) => move(m, "dropped", selfId(readLedger(main)) || "user", a.opt.why ?? null));
      return;
    }
    case "prio": {
      const [id, n] = rest;
      if (!id || n === undefined || !Number.isInteger(Number(n))) die("usage: hwt mq prio <id> <whole number> (higher goes first)");
      withItem(projectRoot(), id, (m) => {
        m.priority = Number(n);
      });
      return;
    }
    case "set": {
      const a = parse(rest, { opts: ["why"], flags: ["force"] }, "hwt mq set <id> <state> [--why TEXT] [--force]");
      const main = projectRoot();
      const [id, st] = a.pos;
      if (!id || !st) die("usage: hwt mq set <id> <state> [--why TEXT] [--force]");
      if (!STATES.includes(st as MergeState)) die(`state: ${STATES.join("|")}`);
      const by = selfId(readLedger(main)) || "user";
      withItem(main, id, (m) => move(m, st as MergeState, by, a.opt.why ?? null, !!a.flag.force));
      return;
    }
    default:
      die(`usage: ${MQ_USAGE}`);
  }
}

// ---- Daemon -------------------------------------------------------------------------------
// One process per computer for every repo's queue (daemon.ts). Not tied to a main: it starts anywhere.

const DAEMON_USAGE = "hwt mq daemon [--interval S] [--once] | daemon status | daemon install [--interval S] | daemon uninstall";

function cmdDaemon(args: string[]): void {
  const [sub, ...rest] = args[0] && !args[0].startsWith("-") ? args : ["run", ...args];
  const interval = (a: ReturnType<typeof parse>) => {
    const n = Number(a.opt.interval ?? 60);
    if (!Number.isFinite(n) || n < 5) die(`--interval needs seconds (5 or more): ${a.opt.interval}`);
    return n;
  };
  switch (sub) {
    case "run": {
      const a = parse(rest, { opts: ["interval"], flags: ["once"] }, DAEMON_USAGE);
      return runDaemon({
        interval: interval(a),
        once: !!a.flag.once,
        remove: (main, branch) => void removeWorktree(main, branch, { deleteBranch: true, killAgents: true }),
      });
    }
    case "status": {
      const d = liveDaemon();
      const repos = knownRepos().map((repo) => {
        if (!existsSync(repo) || !isGit(repo)) return { repo, gone: true };
        try {
          const l = readLedger(repo);
          const open = (l.merges ?? []).filter((m) => OPEN.includes(m.state));
          return { repo, open: open.length, waiting_user: open.filter((m) => m.state === "waiting_user" && !m.approved).length };
        } catch (e) {
          return { repo, error: (e as Error).message };
        }
      });
      return printJson({
        running: !!d, pid: d?.pid ?? null, host: d?.host ?? null, since: d?.since ?? null,
        last_round: d ? new Date(d.beat).toISOString() : null, interval: d?.interval ?? null,
        service: process.platform === "darwin" ? serviceInstalled() : null, log: process.platform === "darwin" ? daemonLog() : null,
        repos,
      }, true);
    }
    case "install": {
      const a = parse(rest, { opts: ["interval"] }, DAEMON_USAGE);
      return printJson(installService(interval(a)));
    }
    case "uninstall":
      return printJson(uninstallService());
    default:
      die(`usage: ${DAEMON_USAGE}`);
  }
}
