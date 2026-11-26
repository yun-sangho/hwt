// The merge queue: a queue in the ledger (ledger.merges, ledger.mq) and the runner that drains it.
//
//   order     priority (high first), then place in line (seq). A re-queued branch keeps its place.
//   blocked   an item waits while a branch in its `after` hasn't merged.
//   states    only the moves in MOVES are allowed; every move is kept in the item's history.
//   plan      a pure function from an item and its checks to the next step (merge, update, wait, return, ask).
//   runner    `hwt mq run`: one runner per repo at a time (a lease in the ledger), one merge at a time; each
//             merge goes through the deploy check and cleanup before the next one starts.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { langFor, mainConfig, type MergeQueueConfig } from "./config.ts";
import { currentBranch, git, gitOut, isDirty } from "./git.ts";
import * as herdr from "./herdr.ts";
import { readLedger, updateLedger, type Ledger, type Merge, type MergeState, type MqLease } from "./ledger.ts";
import { messages } from "./messages.ts";
import { notifyMain, ownerOf } from "./session.ts";
import { die, has, run, sleepMs, stamp, warn } from "./util.ts";

// ---- States -------------------------------------------------------------------------------

export const MOVES: Record<MergeState, MergeState[]> = {
  queued: ["updating", "waiting_user", "merging", "verifying", "returned", "dropped"],
  updating: ["queued", "waiting_user", "merging", "verifying", "returned", "dropped"],
  waiting_user: ["queued", "returned", "dropped"],
  merging: ["verifying", "queued", "returned"],
  verifying: ["cleaning", "done", "failed"],
  cleaning: ["done"],
  returned: ["queued", "dropped"],
  // A person may fix a failed deploy by hand and call it done.
  failed: ["queued", "done", "dropped"],
  done: [],
  dropped: [],
};
export const STATES = Object.keys(MOVES) as MergeState[];
/** In line: the runner looks at these. */
export const WAITING: MergeState[] = ["queued", "updating", "waiting_user"];
/** Merged or merging: one at a time for the repo. */
export const IN_FLIGHT: MergeState[] = ["merging", "verifying", "cleaning"];
/** Shown by default (not finished). */
export const OPEN: MergeState[] = [...WAITING, ...IN_FLIGHT, "returned"];

/** Move <m> to <to>, or throw when MOVES doesn't allow it (force skips the check, for a person's override). */
export function move(m: Merge, to: MergeState, by: string, why: string | null = null, force = false): void {
  if (m.state !== to && !force && !MOVES[m.state]?.includes(to)) {
    die(`merge ${m.id}: ${m.state} → ${to} is not allowed (from ${m.state}: ${MOVES[m.state]?.join(", ") || "nothing"})`);
  }
  (m.history ??= []).push({ at: stamp(), from: m.state ?? null, to, by, why });
  m.state = to;
  m[to] = stamp();
  m.why = why;
}

// ---- Order --------------------------------------------------------------------------------

/** Items written before there was a seq get one from their place in the list. */
function seqOf(l: Ledger, m: Merge): number {
  return m.seq ?? (l.merges ?? []).indexOf(m) - 1_000_000;
}

/** Priority (high first), then place in line. */
export function ordered(l: Ledger, items = l.merges ?? []): Merge[] {
  return [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || seqOf(l, a) - seqOf(l, b));
}

/** The next place in line. Call inside updateLedger. */
export function nextSeq(l: Ledger): number {
  l.mq ??= { seq: 0, lease: null };
  return ++l.mq.seq;
}

/** Branches in m.after that haven't merged yet. A branch with no merge request and no live worktree counts as merged. */
export function blockedBy(l: Ledger, m: Merge): string[] {
  return (m.after ?? []).filter((b) => {
    const ms = (l.merges ?? []).filter((x) => x.branch === b);
    if (ms.some((x) => x.state === "done")) return false;
    if (ms.some((x) => x.state !== "dropped")) return true;
    return l.worktrees[b]?.state === "active";
  });
}

// ---- Checks -------------------------------------------------------------------------------

export interface PrInfo {
  state: string;
  mergeable: string;
  mergeStateStatus: string | null;
  ci: "pass" | "fail" | "pending" | null;
  failing: string[];
  base: string | null;
}

export interface Checks {
  base: string;
  conflict: boolean;
  dirty: boolean | null;
  /** Local commits the PR doesn't have yet (not pushed). */
  unpushed: number;
  ahead: number;
  behind: number;
  pr: PrInfo | null;
  lines: number;
  approval: "auto" | "user";
  approval_why: string[];
  ready: boolean;
}

export function prInfo(main: string, pr: number): PrInfo | null {
  if (!has("gh")) return null;
  const r = run(["gh", "pr", "view", String(pr), "--json", "state,mergeable,mergeStateStatus,statusCheckRollup,baseRefName"], { cwd: main });
  if (!r.ok) return null;
  try {
    const v = JSON.parse(r.out) as {
      state: string;
      mergeable: string;
      mergeStateStatus?: string;
      baseRefName?: string;
      statusCheckRollup?: { name?: string; context?: string; conclusion?: string; state?: string }[];
    };
    const rollup = v.statusCheckRollup ?? [];
    const word = (x: { conclusion?: string; state?: string }) => x.conclusion || x.state || "";
    const failing = rollup
      .filter((x) => ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED"].includes(word(x)))
      .map((x) => x.name || x.context || "?");
    const ci = rollup.length === 0
      ? null
      : failing.length
        ? "fail"
        : rollup.every((x) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(word(x)))
          ? "pass"
          : "pending";
    return { state: v.state, mergeable: v.mergeable, mergeStateStatus: v.mergeStateStatus ?? null, ci, failing, base: v.baseRefName ?? null };
  } catch {
    return null;
  }
}

const hasRef = (main: string, ref: string) => git(["show-ref", "--verify", "--quiet", ref], main).ok;
export const hasOrigin = (main: string) => !!gitOut(["remote", "get-url", "origin"], main);

/** The branch PRs merge into: the PR's base, the config's, origin's HEAD, else the main checkout's branch. */
export function baseBranch(main: string, prBase?: string | null): string {
  const head = gitOut(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], main)?.replace(/^origin\//, "");
  return prBase || mainConfig(main).mergeQueue?.base || head || currentBranch(main);
}

/** A branch as the remote has it when there is one (that is what the PR merges), else the local branch. */
const remoteOr = (main: string, b: string) => (hasRef(main, `refs/remotes/origin/${b}`) ? `origin/${b}` : b);

/**
 * Checks per item: worktree clean, unpushed commits, commits ahead of the base, behind it, conflicts with it
 * now (git merge-tree), PR state and CI (with gh), and who may merge: "user" when it touches a mergeApproval
 * path, changes more than mergeApproval.maxLines lines, or a note names its branch.
 */
export function mqChecks(main: string, m: Pick<Merge, "branch" | "pr" | "path">, l = readLedger(main)): Checks {
  const prj = m.pr ? prInfo(main, m.pr) : null;
  const baseName = baseBranch(main, prj?.base);
  const base = remoteOr(main, baseName);
  const head = remoteOr(main, m.branch);
  const count = (range: string) => Number(gitOut(["rev-list", "--count", range], main) ?? 0) || 0;
  const conflict = !git(["merge-tree", "--write-tree", base, head], main).ok;
  const ahead = count(`${base}..${head}`);
  const behind = count(`${head}..${base}`);
  const unpushed = head === m.branch ? 0 : count(`${head}..${m.branch}`);
  const dirty = existsSync(m.path) ? isDirty(m.path) : null;
  const files = (gitOut(["diff", "--name-only", `${base}...${head}`], main) ?? "").split("\n").filter(Boolean);
  const lines = (gitOut(["diff", "--numstat", `${base}...${head}`], main) ?? "")
    .split("\n")
    .reduce((s, x) => {
      const [a, d] = x.split("\t");
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
  // A note about this branch is the person's word on it: a main reads it before the merge goes ahead.
  for (const n of l.notes) if (n.branch === m.branch) why.push(`note: ${n.text}`);
  return {
    base, conflict, dirty, unpushed, ahead, behind, pr: prj, lines,
    approval: why.length ? "user" : "auto",
    approval_why: why,
    ready: !conflict && dirty !== true && ahead > 0 && (prj === null || (prj.state === "OPEN" && prj.ci === "pass")),
  };
}

// ---- Plan ---------------------------------------------------------------------------------

export type Step =
  | { act: "merge" }
  | { act: "update"; why: string }
  | { act: "wait"; why: string }
  | { act: "blocked"; why: string }
  | { act: "ask"; why: string }
  | { act: "return"; why: string; rebase?: boolean }
  | { act: "merged_elsewhere" }
  | { act: "drop"; why: string };

/** The next step for an item in line. Pure: the runner does what it says. */
export function plan(m: Merge, c: Checks, o: { maxUpdates: number; blockedBy: string[] }): Step {
  if (o.blockedBy.length) return { act: "blocked", why: `after ${o.blockedBy.join(", ")}` };
  if (m.pr == null) return { act: "return", why: "no PR: open one, then hwt mq add --pr <n>" };
  if (!c.pr) return { act: "wait", why: "can't read the PR (gh)" };
  if (c.pr.state === "MERGED") return { act: "merged_elsewhere" };
  if (c.pr.state === "CLOSED") return { act: "drop", why: "PR closed" };
  if (c.dirty) return { act: "return", why: "uncommitted changes in the worktree: commit and push them" };
  if (c.unpushed > 0) return { act: "return", why: `${c.unpushed} commit(s) not pushed: push them` };
  if (c.ahead === 0) return { act: "return", why: `no commits ahead of ${c.base}` };
  if (c.conflict || c.pr.mergeable === "CONFLICTING" || c.pr.mergeStateStatus === "DIRTY") {
    return { act: "return", why: `conflicts with ${c.base}: rebase and push`, rebase: true };
  }
  if (c.approval === "user" && !m.approved) return { act: "ask", why: c.approval_why.join("; ") };
  if (c.pr.ci === "fail") return { act: "return", why: `CI failed: ${c.pr.failing.join(", ")}` };
  if (c.behind > 0 || c.pr.mergeStateStatus === "BEHIND") {
    if ((m.updates ?? 0) >= o.maxUpdates) {
      return { act: "return", why: `still behind ${c.base} after ${m.updates} update(s): rebase and push`, rebase: true };
    }
    return { act: "update", why: `${c.behind} commit(s) behind ${c.base}` };
  }
  if (c.pr.ci === "pending" || c.pr.mergeable === "UNKNOWN") return { act: "wait", why: "CI running" };
  if (c.pr.mergeStateStatus === "BLOCKED") return { act: "ask", why: "branch protection blocks the merge (review?)" };
  return { act: "merge" };
}

// ---- Lease --------------------------------------------------------------------------------

const STALE_MS = 10 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function leaseLive(x: MqLease | null | undefined): x is MqLease {
  if (!x) return false;
  if (Date.now() - x.beat > STALE_MS) return false;
  return x.host !== hostname() || pidAlive(x.pid);
}

const mine = (x: MqLease | null | undefined) => !!x && x.pid === process.pid && x.host === hostname();

export function acquireLease(main: string, holder: string): void {
  let held: MqLease | null = null;
  updateLedger(main, (l) => {
    l.mq ??= { seq: (l.merges ?? []).length, lease: null };
    if (leaseLive(l.mq.lease) && !mine(l.mq.lease)) {
      held = l.mq.lease;
      return;
    }
    l.mq.lease = { holder, pid: process.pid, host: hostname(), since: stamp(), beat: Date.now() };
  });
  if (held) {
    const h = held as MqLease;
    die(`the merge queue runner is already running (${h.holder}, pid ${h.pid} on ${h.host}, since ${h.since})`);
  }
}

function beat(main: string): void {
  updateLedger(main, (l) => {
    if (mine(l.mq?.lease)) l.mq!.lease!.beat = Date.now();
  });
}

function releaseLease(main: string): void {
  updateLedger(main, (l) => {
    if (mine(l.mq?.lease)) l.mq!.lease = null;
  });
}

// ---- Runner -------------------------------------------------------------------------------

export interface RunOptions {
  watch: boolean;
  /** Seconds between passes while watching. */
  interval: number;
  /** Seconds a watching runner stays up. */
  timeout: number;
  dryRun: boolean;
  /** The runner's name in histories and the lease (the main that started it). */
  by: string;
  /** Removes a worktree (hwt rm -D --kill-agents); passed in so this module doesn't import the commands. */
  remove: (branch: string) => void;
}

export interface RunEvent {
  id: string;
  branch: string;
  from: MergeState;
  to: MergeState;
  why: string | null;
}

export interface RunReport {
  events: RunEvent[];
  merged: string[];
  /** Items still in line, with what they wait for. */
  waiting: { id: string; branch: string; state: MergeState; step: Step }[];
  unblocked_tasks: { id: string; title: string; owner: string | null }[];
  dry_run?: boolean;
}

const queueConfig = (main: string): Required<Pick<MergeQueueConfig, "method" | "verifyTimeout" | "cleanup" | "maxUpdates">> & MergeQueueConfig => ({
  method: "squash",
  verifyTimeout: 1800,
  cleanup: true,
  maxUpdates: 3,
  ...mainConfig(main).mergeQueue,
});

function tail(s: string, n = 20): string {
  return s.trim().split("\n").slice(-n).join("\n");
}

/** Drain the queue: see the file comment. Returns what happened and what still waits. */
export function runQueue(main: string, o: RunOptions): RunReport {
  const cfg = queueConfig(main);
  const m = messages(langFor(main));
  const report: RunReport = { events: [], merged: [], waiting: [], unblocked_tasks: [] };
  if (o.dryRun) report.dry_run = true;

  /** Change one item in the ledger (under its lock) and log the move. */
  const moveItem = (id: string, to: MergeState, why: string | null, change?: (x: Merge) => void) => {
    updateLedger(main, (l) => {
      const x = (l.merges ?? []).find((y) => y.id === id);
      if (!x) return;
      const from = x.state;
      change?.(x);
      if (from !== to) {
        move(x, to, o.by, why);
        report.events.push({ id, branch: x.branch, from, to, why });
      } else x.why = why;
    });
  };

  /** Tell the working session (if live) and its main what came back to it. */
  const giveBack = (x: Merge, text: string) => {
    const agent = herdr.terminals().find((t) => herdr.isLive(t) && herdr.isAgent(t) && herdr.inDir(t, x.path))?.address;
    if (agent) herdr.send(agent, text);
    const owner = ownerOf(readLedger(main), x.branch);
    if (owner) notifyMain(main, owner, { branch: x.branch, path: x.path, text });
  };

  const fetch = () => {
    if (hasOrigin(main)) run(["git", "fetch", "-q", "--prune", "origin"], { cwd: main });
  };

  /** Merged: run the deploy check, then clean up. Returns false when the check failed. */
  const finish = (id: string): boolean => {
    const x = readLedger(main).merges?.find((y) => y.id === id);
    if (!x) return false;
    if (x.state === "merging") moveItem(id, "verifying", null);
    if (x.state === "merging" || x.state === "verifying") {
      if (cfg.verify) {
        const r = Bun.spawnSync({
          cmd: ["sh", "-c", cfg.verify],
          cwd: main,
          env: { ...process.env, HWT_MQ_ID: id, HWT_MQ_BRANCH: x.branch, HWT_MQ_PR: String(x.pr ?? ""), HWT_MQ_SHA: x.sha ?? "" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: cfg.verifyTimeout * 1000,
        });
        if (r.exitCode !== 0) {
          const log = tail(`${r.stdout.toString()}\n${r.stderr.toString()}`);
          const why = `deploy check failed (exit ${r.exitCode ?? "timeout"})`;
          moveItem(id, "failed", why);
          giveBack(x, `${m.tags.deployFailed} ${id} ${x.branch}: ${why}\n${log}`);
          return false;
        }
      }
      moveItem(id, cfg.cleanup ? "cleaning" : "done", null);
    }
    if (!cfg.cleanup) return true;
    const l = readLedger(main);
    const notes: string[] = [];
    const w = l.worktrees[x.branch];
    const ownMain = !!w?.self_main;
    if (ownMain) notes.push("worktree kept: its session is a main of its own");
    else if (w?.state === "active") {
      try {
        o.remove(x.branch);
      } catch (e) {
        notes.push(`hwt rm failed: ${(e as Error).message}`);
      }
    }
    if (hasOrigin(main) && hasRef(main, `refs/remotes/origin/${x.branch}`)) run(["git", "push", "-q", "origin", "--delete", x.branch], { cwd: main });
    if (cfg.gc) {
      const g = run(["sh", "-c", cfg.gc], { cwd: main });
      if (!g.ok) notes.push(`gc failed: ${tail(g.err || g.out, 3)}`);
    }
    // Keep the main checkout on the merged base, so new worktrees start from it.
    fetch();
    const base = baseBranch(main);
    const tracked = (gitOut(["status", "--porcelain", "--untracked-files=no"], main) ?? "") === "";
    if (currentBranch(main) === base && tracked && hasRef(main, `refs/remotes/origin/${base}`)) {
      run(["git", "merge", "-q", "--ff-only", `origin/${base}`], { cwd: main });
    }
    updateLedger(main, (l2) => {
      for (const t of l2.tasks ?? []) {
        if (t.branch === x.branch && t.state === "running") Object.assign(t, { state: "done", closed: stamp() });
        if (t.state === "decided" && t.decision === `after:${x.branch}`) report.unblocked_tasks.push({ id: t.id, title: t.title, owner: t.owner ?? null });
      }
    });
    for (const t of report.unblocked_tasks.filter((t) => t.owner)) {
      notifyMain(main, t.owner!, { branch: x.branch, path: main, text: `${m.tags.unblocked} ${t.id} ${t.title} (after:${x.branch} merged)` });
    }
    moveItem(id, "done", notes.join("; ") || null);
    return true;
  };

  /** One item in line: plan and do its step. Returns true when it merged (the base moved: start over). */
  const step = (x: Merge, s: Step): boolean => {
    switch (s.act) {
      case "merge": {
        moveItem(x.id, "merging", null);
        const r = run(["gh", "pr", "merge", String(x.pr), `--${cfg.method}`], { cwd: main });
        const after = prInfo(main, x.pr!);
        if (!r.ok && after?.state !== "MERGED") {
          // A race (the base moved, a check just failed): back in line, the next pass looks again.
          moveItem(x.id, "queued", `gh pr merge failed: ${tail(r.err || r.out, 3)}`);
          return false;
        }
        const sha = runOut(["gh", "pr", "view", String(x.pr), "--json", "mergeCommit", "--jq", ".mergeCommit.oid"], main);
        moveItem(x.id, "verifying", null, (y) => {
          if (sha) y.sha = sha;
        });
        report.merged.push(x.branch);
        finish(x.id);
        return true;
      }
      case "merged_elsewhere":
        moveItem(x.id, "verifying", "merged outside the queue");
        report.merged.push(x.branch);
        finish(x.id);
        return true;
      case "update": {
        const r = run(["gh", "pr", "update-branch", String(x.pr)], { cwd: main });
        if (!r.ok) {
          moveItem(x.id, "returned", `gh pr update-branch failed: ${tail(r.err || r.out, 3)}`);
          giveBack(x, `${m.tags.rebaseRequest} ${x.id} ${x.branch}: ${s.why}; couldn't update it here, rebase and push, then hwt mq add again`);
          return false;
        }
        moveItem(x.id, "updating", s.why, (y) => {
          y.updates = (y.updates ?? 0) + 1;
        });
        giveBack(x, `${m.tags.baseUpdated} ${x.id} ${x.branch}: ${m.baseUpdated}`);
        return false;
      }
      case "return":
        moveItem(x.id, "returned", s.why);
        giveBack(x, `${s.rebase ? m.tags.rebaseRequest : m.tags.returned} ${x.id} ${x.branch}: ${s.why}. ${m.requeue}`);
        return false;
      case "ask":
        if (x.state !== "waiting_user") {
          moveItem(x.id, "waiting_user", s.why);
          const owner = ownerOf(readLedger(main), x.branch);
          const text = `${m.tags.approval} ${x.id} ${x.branch}${x.pr ? ` PR #${x.pr}` : ""}: ${s.why} — hwt mq approve ${x.id}`;
          if (owner) notifyMain(main, owner, { branch: x.branch, path: x.path, text });
          else warn(text);
        }
        return false;
      case "drop":
        moveItem(x.id, "dropped", s.why);
        return false;
      case "wait":
      case "blocked":
        // Stays in line. updating → queued once CI has picked the update up is not needed: plan reads CI.
        return false;
    }
  };

  /** One pass over the line: in-flight items first (a crashed runner left them), then in order. */
  const pass = (): boolean => {
    fetch();
    let l = readLedger(main);
    for (const x of ordered(l).filter((y) => IN_FLIGHT.includes(y.state))) {
      if (o.dryRun) {
        report.waiting.push({ id: x.id, branch: x.branch, state: x.state, step: { act: "wait", why: `${x.state}: resumes here` } });
        return false;
      }
      if (x.state === "merging") {
        const p = x.pr ? prInfo(main, x.pr) : null;
        if (p?.state !== "MERGED") {
          moveItem(x.id, "queued", "merge didn't finish; back in line");
          continue;
        }
      }
      finish(x.id);
      return true;
    }
    l = readLedger(main);
    for (const x of ordered(l).filter((y) => y.state === "queued" || y.state === "updating" || y.state === "waiting_user")) {
      if (x.state === "waiting_user" && !x.approved) continue;
      const c = mqChecks(main, x, l);
      const s = plan(x, c, { maxUpdates: cfg.maxUpdates, blockedBy: blockedBy(l, x) });
      if (o.dryRun) {
        report.waiting.push({ id: x.id, branch: x.branch, state: x.state, step: s });
        continue;
      }
      if (step(x, s)) return true;
    }
    return false;
  };

  const leftover = () => {
    if (o.dryRun) return;
    fetch();
    const l = readLedger(main);
    report.waiting = ordered(l)
      .filter((x) => WAITING.includes(x.state))
      .map((x) => ({
        id: x.id,
        branch: x.branch,
        state: x.state,
        step: x.state === "waiting_user" && !x.approved
          ? ({ act: "ask", why: x.why ?? "" } as Step)
          : plan(x, mqChecks(main, x, l), { maxUpdates: cfg.maxUpdates, blockedBy: blockedBy(l, x) }),
      }));
  };

  if (o.dryRun) {
    pass();
    return report;
  }
  acquireLease(main, o.by);
  try {
    const end = Date.now() + o.timeout * 1000;
    for (;;) {
      beat(main);
      if (pass()) continue; // merged: the base moved, look at the line again
      const l = readLedger(main);
      const inLine = (l.merges ?? []).some((x) => x.state === "queued" || x.state === "updating" || (x.state === "waiting_user" && x.approved));
      if (!o.watch || !inLine || Date.now() >= end) break;
      sleepMs(Math.min(o.interval * 1000, Math.max(0, end - Date.now())));
    }
  } finally {
    releaseLease(main);
  }
  leftover();
  return report;
}

function runOut(cmd: string[], cwd: string): string | null {
  const r = run(cmd, { cwd });
  return r.ok ? r.out.trim() || null : null;
}
