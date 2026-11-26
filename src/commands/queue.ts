// hwt task … (ledger.tasks) and hwt mq … (ledger.merges)
import { existsSync } from "node:fs";
import { parse } from "../args.ts";
import { langFor } from "../config.ts";
import { currentBranch, samePath, toplevel, touchedPaths } from "../git.ts";
import { childKey, isGit, projectRoot, requireGit } from "../project.ts";
import * as herdr from "../herdr.ts";
import { readLedger, updateLedger, type MergeState } from "../ledger.ts";
import { messages } from "../messages.ts";
import { die, printJson, shortId, stamp } from "../util.ts";
import { tell } from "./session.ts";
import { removeWorktree } from "./worktree.ts";
import {
  blockedBy, IN_FLIGHT, leaseLive, move, mqChecks, nextSeq, OPEN, ordered, plan, queueConfig, runQueue, STATES, WAITING,
} from "../mq.ts";
import type { Merge } from "../ledger.ts";
import { actsAsMain, ownerOf, owns, selfId } from "../session.ts";

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
       mq approve <id> [--why T] | drop <id> [--why T] | prio <id> <n> | set <id> <state> [--why T] [--force]`;

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
  if (!help) requireGit(projectRoot(), "the merge queue");
  switch (sub) {
    case "--help":
    case "-h":
      return void process.stdout.write(`usage: ${MQ_USAGE}\n`);
    case "add": {
      const a = parse(rest, { opts: ["pr", "after", "priority"] }, "hwt mq add [--pr N] [--after b1,b2] [--priority N] [TEXT]");
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
        for (let suffix = 2; merges.some((m) => m.id === id); suffix++) id = `${initialId}-${suffix}`;
        // A branch queued again (after a return or failure) keeps its place in line, and replaces the old request.
        const old = merges.filter((m) => m.branch === b && [...WAITING, "returned", "failed"].includes(m.state));
        kept = old.map((m) => m.seq).find((x) => x !== undefined);
        const prev = old[0];
        const item: Merge = {
          id, branch: b, pr, path: here, from: herdr.myTerminal(), note: text, requested: stamp(), state: "queued", why: null,
          seq: kept ?? nextSeq(l),
          priority: priority ?? prev?.priority ?? 0,
          after: a.opt.after ? a.opt.after.split(",").filter(Boolean) : (prev?.after ?? []),
          updates: 0,
          history: [{ at: stamp(), from: null, to: "queued", by: herdr.myTerminal() || b, why: old.length ? `again (was ${old.map((m) => m.id).join(", ")})` : null }],
        };
        for (const m of old) move(m, "dropped", b, `replaced by ${id}`, true);
        l.merges = [...merges, item];
      });
      // A log entry only: the runner takes it from the queue; the main is woken only if it needs a decision.
      tell(`${messages(langFor(main)).tags.mergeRequest} ${id} ${b}${pr ? ` PR #${pr}` : ""}${text ? ` — ${text}` : ""}`, { wake: false });
      return printJson({ merge: id, branch: b, state: "queued", place_kept: kept !== undefined });
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
      if (busy) return printJson({ busy, runner: lease }, true);
      const { maxUpdates, requireChecks } = queueConfig(main);
      const mineInLine = ordered(l).filter((m) => m.state === "queued" || m.state === "updating").filter((m) => owns(me, ownerOf(l, m.branch)));
      const next = mineInLine[0];
      const checks = next ? mqChecks(main, next, l) : null;
      return printJson(
        {
          next: next && checks
            ? { ...next, checks, plan: plan(next, checks, { maxUpdates, requireChecks, blockedBy: blockedBy(l, next) }), may_merge: checks.approval === "auto" || next.approved != null }
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
      withItem(main, id, (m) => {
        Object.assign(m, { approved: stamp(), approved_why: a.opt.why ?? "" });
        if (m.state === "waiting_user") move(m, "queued", by, `approved${a.opt.why ? `: ${a.opt.why}` : ""}`);
      });
      return;
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
