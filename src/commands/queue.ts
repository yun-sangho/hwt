// hwt task … (ledger.tasks) and hwt mq … (ledger.merges)
import { existsSync } from "node:fs";
import { parse } from "../args.ts";
import { langFor, mainConfig } from "../config.ts";
import { currentBranch, git, gitOut, isDirty, repoMain, samePath, toplevel, touchedPaths } from "../git.ts";
import * as herdr from "../herdr.ts";
import { readLedger, updateLedger, type Merge, type MergeState } from "../ledger.ts";
import { messages } from "../messages.ts";
import { die, has, printJson, run, shortId, stamp } from "../util.ts";
import { tell } from "./session.ts";

// ---- Tasks ------------------------------------------------------------------------------
// Anyone may add (the person via the main session, or a working session that found more work);
// only the main session decides (now / later / after:<branch>) and starts tasks (hwt new --task-id).

const TASK_USAGE = "hwt task add|ls|decide|done|drop";

export function cmdTask(args: string[]): void {
  const [sub = "ls", ...rest] = args;
  switch (sub) {
    case "--help":
    case "-h":
      return void process.stdout.write(`usage: ${TASK_USAGE}\n`);
    case "add": {
      const a = parse(rest, { opts: ["touches", "detail"] }, "hwt task add <title> [--touches p1,p2] [--detail TEXT]");
      const main = repoMain();
      const title = a.pos.join(" ");
      if (!title) die("usage: hwt task add <title> [--touches p1,p2] [--detail TEXT]");
      const touches = a.opt.touches ?? "";
      const id = shortId("T");
      const here = toplevel();
      const from = here && !samePath(here, main) ? currentBranch() : "user";
      updateLedger(main, (l) => {
        l.tasks = [
          ...(l.tasks ?? []),
          {
            id, title, detail: a.opt.detail ?? "", touches: touches.split(",").filter(Boolean), from, added: stamp(),
            state: "queued", decision: null, why: null, branch: null,
          },
        ];
      });
      // From a working session: also put it in front of the main session.
      if (from !== "user") tell(messages(langFor(main)).taskProposal(id, title, touches));
      return printJson({ task: id, from, state: "queued" });
    }
    case "ls": {
      const main = repoMain();
      const all = rest[0] === "--all";
      const l = readLedger(main);
      const active = Object.entries(l.worktrees)
        .filter(([, w]) => w.state === "active" && existsSync(w.path))
        .flatMap(([b, w]) => touchedPaths(w.path, main).map((path) => ({ branch: b, path })));
      return printJson(
        (l.tasks ?? [])
          .filter((t) => all || ["queued", "decided", "running"].includes(t.state))
          .map((t) => ({
            ...t,
            overlaps: [...new Set(t.touches.flatMap((p) => active.filter((x) => x.path.startsWith(p)).map((x) => x.branch)))],
          })),
        true,
      );
    }
    case "decide": {
      const a = parse(rest, { opts: ["why"] }, "hwt task decide <id> now|later|after:<branch> --why TEXT");
      const main = repoMain();
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
      const main = repoMain();
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
// Working sessions don't merge. They ask (`hwt mq add`), then stay up for fixes. The main session takes
// one item at a time: check → merge → verify deploy → clean up the worktree (and the repo's gc) → next.

interface PrInfo {
  state: string;
  mergeable: string;
  ci: "pass" | "fail" | "pending" | null;
}

export interface Checks {
  conflict: boolean;
  dirty: boolean | null;
  ahead: number;
  behind: number;
  pr: PrInfo | null;
  lines: number;
  approval: "auto" | "user";
  approval_why: string[];
  ready: boolean;
}

function prInfo(main: string, pr: number): PrInfo | null {
  if (!has("gh")) return null;
  const r = run(["gh", "pr", "view", String(pr), "--json", "state,mergeable,statusCheckRollup"], { cwd: main });
  if (!r.ok) return null;
  try {
    const v = JSON.parse(r.out) as { state: string; mergeable: string; statusCheckRollup?: { conclusion?: string; state?: string }[] };
    const c = (v.statusCheckRollup ?? []).map((x) => x.conclusion || x.state || "");
    const ci = c.length === 0
      ? null
      : c.every((x) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(x))
        ? "pass"
        : c.some((x) => ["FAILURE", "CANCELLED", "TIMED_OUT"].includes(x))
          ? "fail"
          : "pending";
    return { state: v.state, mergeable: v.mergeable, ci };
  } catch {
    return null;
  }
}

/**
 * Checks per item: worktree clean, commits ahead of the main branch, behind it (needs a rebase), conflicts
 * with it now (git merge-tree), PR state and CI (with gh), and who may merge: "user" when it touches a
 * mergeApproval path in the main checkout's .hwt.json or changes more than mergeApproval.maxLines lines.
 */
export function mqChecks(main: string, branch: string, pr: number | null, wt: string): Checks {
  const mb = currentBranch(main);
  const conflict = !git(["merge-tree", "--write-tree", mb, branch], main).ok;
  const count = (range: string) => Number(gitOut(["rev-list", "--count", range], main) ?? 0) || 0;
  const ahead = count(`${mb}..${branch}`);
  const behind = count(`${branch}..${mb}`);
  const dirty = existsSync(wt) ? isDirty(wt) : null;
  const prj = pr ? prInfo(main, pr) : null;
  const files = (gitOut(["diff", "--name-only", `${mb}...${branch}`], main) ?? "").split("\n").filter(Boolean);
  const lines = (gitOut(["diff", "--numstat", `${mb}...${branch}`], main) ?? "")
    .split("\n")
    .reduce((s, l) => {
      const [a, d] = l.split("\t");
      return s + (Number(a) || 0) + (Number(d) || 0);
    }, 0);
  const cfg = mainConfig(main).mergeApproval ?? {};
  const why: string[] = [];
  for (const pat of cfg.paths ?? []) {
    const g = new Bun.Glob(pat);
    const hit = files.find((f) => g.match(f));
    if (hit) why.push(`${pat}: ${hit}`);
  }
  const maxl = cfg.maxLines ?? 0;
  if (maxl > 0 && lines > maxl) why.push(`${lines} lines > ${maxl}`);
  return {
    conflict, dirty, ahead, behind, pr: prj, lines,
    approval: why.length ? "user" : "auto",
    approval_why: why,
    ready: !conflict && dirty !== true && ahead > 0 && (prj === null || (prj.state === "OPEN" && prj.ci === "pass")),
  };
}

const MQ_STATES: MergeState[] = ["merging", "verifying", "done", "returned", "failed", "waiting_user"];

const MQ_USAGE = "hwt mq add|ls|next|set|approve";

export function cmdMq(args: string[]): void {
  const [sub = "ls", ...rest] = args;
  switch (sub) {
    case "--help":
    case "-h":
      return void process.stdout.write(`usage: ${MQ_USAGE}\n`);
    case "add": {
      const a = parse(rest, { opts: ["pr"] }, "hwt mq add [--pr N] [TEXT]");
      const main = repoMain();
      const text = a.pos.join(" ");
      const pr = a.opt.pr ? Number(a.opt.pr) : null;
      if (a.opt.pr && !Number.isInteger(pr)) die(`--pr needs a number: ${a.opt.pr}`);
      const here = toplevel();
      if (!here || samePath(here, main)) die("mq add runs in the working worktree (it queues that branch)");
      const b = currentBranch();
      const id = shortId("M");
      updateLedger(main, (l) => {
        // A new request replaces this branch's older queued/returned one.
        l.merges = [
          ...(l.merges ?? []).filter((m) => m.branch !== b || !["queued", "returned"].includes(m.state)),
          { id, branch: b, pr, path: here, from: herdr.myTerminal(), note: text, requested: stamp(), state: "queued", why: null },
        ];
      });
      tell(`${messages(langFor(main)).tags.mergeRequest} ${id} ${b}${pr ? ` PR #${pr}` : ""}${text ? ` — ${text}` : ""}`);
      return printJson({ merge: id, branch: b, state: "queued" });
    }
    case "ls":
    case "next": {
      const main = repoMain();
      const all = rest[0] === "--all";
      const l = readLedger(main);
      const items = (l.merges ?? [])
        .filter((m) => all || !["done", "failed"].includes(m.state))
        .map((m) => ({ ...m, title: l.worktrees[m.branch]?.title ?? "", checks: mqChecks(main, m.branch, m.pr, m.path) }));
      if (sub === "ls") return printJson(items, true);
      const busy = items.find((m) => m.state === "merging" || m.state === "verifying");
      if (busy) return printJson({ busy }, true);
      const next = items.find((m) => m.state === "queued");
      return printJson(
        {
          next: next ? { ...next, may_merge: next.checks.approval === "auto" || next.approved != null } : null,
          waiting_user: items.filter((m) => m.state === "waiting_user").map((m) => ({ id: m.id, branch: m.branch, why: m.checks.approval_why })),
        },
        true,
      );
    }
    case "approve": {
      const a = parse(rest, { opts: ["why"] }, "hwt mq approve <id> [--why TEXT]");
      const main = repoMain();
      const id = a.pos[0] ?? die("usage: hwt mq approve <id> [--why TEXT]");
      const found = updateLedger(main, (l) => {
        for (const m of l.merges ?? []) {
          if (m.id !== id) continue;
          Object.assign(m, { approved: stamp(), approved_why: a.opt.why ?? "" });
          if (m.state === "waiting_user") m.state = "queued";
        }
      }).merges?.some((m) => m.id === id);
      if (!found) die(`no merge request ${id}`);
      return;
    }
    case "set": {
      const a = parse(rest, { opts: ["why"] }, "hwt mq set <id> <state> [--why TEXT]");
      const main = repoMain();
      const [id, st] = a.pos;
      if (!id || !st) die("usage: hwt mq set <id> <state> [--why TEXT]");
      if (!MQ_STATES.includes(st as MergeState)) die(`state: ${MQ_STATES.join("|")}`);
      const found = updateLedger(main, (l) => {
        for (const m of l.merges ?? []) {
          if (m.id !== id) continue;
          (m as Merge).state = st as MergeState;
          m[st] = stamp();
          if (a.opt.why) m.why = a.opt.why;
        }
      }).merges?.some((m) => m.id === id);
      if (!found) die(`no merge request ${id}`);
      return;
    }
    default:
      die(`usage: ${MQ_USAGE}`);
  }
}
