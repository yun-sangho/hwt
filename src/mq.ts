// The merge queue: a queue in the ledger (ledger.merges, ledger.mq) and the runner that drains it.
//
//   order     priority (high first), then place in line (seq). A re-queued branch keeps its place.
//   blocked   an item waits while a branch in its `after` hasn't merged.
//   states    only the moves in MOVES are allowed; every move is kept in the item's history.
//   plan      a pure function from an item and its checks to the next step (merge, update, wait, return, ask).
//   runner    `hwt mq run`: one runner per repo at a time (a lease in the ledger).
//   batch     mergeQueue.batch: merge every ready PR in a pass, then one deploy check for them all.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { langFor, mainConfig, type MergeQueueConfig } from "./config.ts";
import { currentBranch, git, gitOut, isDirty } from "./git.ts";
import * as herdr from "./herdr.ts";
import { readLedger, updateLedger, type Ledger, type Merge, type MergeState, type MqLease } from "./ledger.ts";
import { messages } from "./messages.ts";
import { notifyMain, ownerOf } from "./session.ts";
import { die, has, run, sleepMs, stamp, warn, type RunResult } from "./util.ts";

// ---- States -------------------------------------------------------------------------------

export const MOVES: Record<MergeState, MergeState[]> = {
  queued: ["updating", "waiting_user", "merging", "verifying", "returned", "dropped"],
  updating: ["queued", "waiting_user", "merging", "verifying", "returned", "dropped"],
  waiting_user: ["queued", "returned", "dropped"],
  merging: ["verifying", "queued", "returned"],
  verifying: ["cleaning", "done", "failed", "returned"],
  cleaning: ["verifying", "done", "returned"],
  returned: ["queued", "dropped"],
  // A person may fix a failed deploy by hand and call it done.
  failed: ["queued", "done", "dropped"],
  done: [],
  dropped: [],
};
export const STATES = Object.keys(MOVES) as MergeState[];
/** In line: the runner looks at these. */
export const WAITING: MergeState[] = ["queued", "updating", "waiting_user"];
/** Requests submitted to GitHub or being finalized locally. */
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
    const latest = (l.merges ?? []).findLast((x) => x.branch === b && x.state !== "dropped");
    if (latest) return latest.state !== "done";
    return l.worktrees[b]?.state === "active";
  });
}

// ---- Checks -------------------------------------------------------------------------------

interface PullRequestRef {
  id: string;
  host: string;
}

export interface PrInfo {
  state: string;
  mergeable: string;
  mergeStateStatus: string | null;
  ci: "pass" | "fail" | "pending" | null;
  failing: string[];
  base: string | null;
  head: string | null;
  ref: PullRequestRef | null;
}

export interface Checks {
  base: string;
  head: string | null;
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
  const v = readGhJson(main, ["pr", "view", String(pr), "--json", "state,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,headRefOid,id,url"]);
  if (!v || typeof v.state !== "string" || typeof v.mergeable !== "string") return null;
  const rollup: unknown = v.statusCheckRollup ?? [];
  if (!Array.isArray(rollup) || !rollup.every(isObject)) return null;
  const word = (x: Record<string, unknown>) => nonemptyString(x.conclusion) ?? nonemptyString(x.state) ?? "";
  const failing = rollup
    .filter((x) => ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED"].includes(word(x)))
    .map((x) => nonemptyString(x.name) ?? nonemptyString(x.context) ?? "?");
  const ci = rollup.length === 0
    ? null
    : failing.length
      ? "fail"
      : rollup.every((x) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(word(x)))
        ? "pass"
        : "pending";
  return {
    state: v.state,
    mergeable: v.mergeable,
    mergeStateStatus: nonemptyString(v.mergeStateStatus),
    ci,
    failing,
    base: nonemptyString(v.baseRefName),
    head: nonemptyString(v.headRefOid),
    ref: pullRequestRef(v),
  };
}

type MergeStatus =
  | { kind: "merged"; sha: string }
  | { kind: "queued"; queue: string }
  | { kind: "closed" | "open" | "pending" | "unknown" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonemptyString = (value: unknown): string | null => typeof value === "string" && value ? value : null;

function pullRequestRef(pr: Record<string, unknown>): PullRequestRef | null {
  const host = typeof pr.url === "string" ? URL.parse(pr.url)?.hostname : null;
  const id = nonemptyString(pr.id);
  return host && id ? { id, host } : null;
}

function queueKey(host: string, queue: unknown): string | null {
  const id = isObject(queue) ? nonemptyString(queue.id) : null;
  return id ? `${host}/${id}` : null;
}

function readGhJson(main: string, args: string[]): Record<string, unknown> | null {
  const result = run(["gh", ...args], { cwd: main });
  if (!result.ok) return null;
  try {
    const value: unknown = JSON.parse(result.out);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function mergeState(pr: Record<string, unknown> | null): MergeStatus {
  if (pr?.state === "CLOSED") return { kind: "closed" };
  if (pr?.state === "OPEN") return { kind: "open" };
  if (pr?.state === "MERGED" && isObject(pr.mergeCommit) && typeof pr.mergeCommit.oid === "string" && pr.mergeCommit.oid) {
    return { kind: "merged", sha: pr.mergeCommit.oid };
  }
  return { kind: "unknown" };
}

function mergeStatus(main: string, number: number | null): MergeStatus {
  if (number === null) return { kind: "unknown" };
  const pr = readGhJson(main, ["pr", "view", String(number), "--json", "state,mergeCommit,id,url"]);
  if (!pr) return { kind: "unknown" };
  const state = mergeState(pr);
  if (state.kind !== "open") return state;
  const ref = pullRequestRef(pr);
  if (!ref) return { kind: "unknown" };

  const current = readGhJson(main, [
    "api", "graphql", "--hostname", ref.host, "-f", `id=${ref.id}`,
    "-f", "query=query($id:ID!){node(id:$id){...on PullRequest{state mergeCommit{oid} mergeQueueEntry{id mergeQueue{id}} autoMergeRequest{enabledAt}}}}",
    "--jq", ".data.node",
  ]);
  const observed = mergeState(current);
  if (observed.kind !== "open" || !current) return observed;
  if (current.mergeQueueEntry === null && current.autoMergeRequest === null) return observed;
  if (isObject(current.mergeQueueEntry) && nonemptyString(current.mergeQueueEntry.id)) {
    const queue = queueKey(ref.host, current.mergeQueueEntry.mergeQueue);
    return queue ? { kind: "queued", queue } : { kind: "pending" };
  }
  if (isObject(current.autoMergeRequest) && typeof current.autoMergeRequest.enabledAt === "string") return { kind: "pending" };
  return { kind: "unknown" };
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
  const headRef = remoteOr(main, m.branch);
  const headOid = gitOut(["rev-parse", "--verify", headRef], main);
  const head = headOid ?? headRef;
  const count = (range: string) => Number(gitOut(["rev-list", "--count", range], main) ?? 0) || 0;
  const conflict = !git(["merge-tree", "--write-tree", base, head], main).ok;
  const ahead = count(`${base}..${head}`);
  const behind = count(`${head}..${base}`);
  const unpushed = headRef === m.branch ? 0 : count(`${head}..${m.branch}`);
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
    base, head: headOid, conflict, dirty, unpushed, ahead, behind, pr: prj, lines,
    approval: why.length ? "user" : "auto",
    approval_why: why,
    ready: !conflict && dirty !== true && ahead > 0 && (prj === null || (prj.state === "OPEN" && prj.ci === "pass")),
  };
}

// ---- Plan ---------------------------------------------------------------------------------

type QueueStep =
  | { act: "merge" }
  | { act: "update"; why: string }
  | { act: "wait"; why: string }
  | { act: "blocked"; why: string }
  | { act: "ask"; why: string }
  | { act: "return"; why: string; rebase?: boolean }
  | { act: "merged_elsewhere" }
  | { act: "drop"; why: string };

export type Step = QueueStep | { act: "enqueue" };

/** The next step for an item in line. Pure: the runner does what it says. */
export function plan(
  m: Merge, c: Checks, o: { maxUpdates: number; blockedBy: string[]; requireChecks?: boolean; batch?: boolean | number },
): QueueStep {
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
  // Batching merges a PR that is only behind (GitHub says BEHIND when it requires branches up to date).
  if (c.pr.mergeStateStatus === "BEHIND" || (c.behind > 0 && !o.batch)) {
    if ((m.updates ?? 0) >= o.maxUpdates) {
      return { act: "return", why: `still behind ${c.base} after ${m.updates} update(s): rebase and push`, rebase: true };
    }
    return { act: "update", why: `${c.behind} commit(s) behind ${c.base}` };
  }
  if (c.pr.ci === "pending" || c.pr.mergeable === "UNKNOWN") return { act: "wait", why: "CI running" };
  if (c.pr.ci === null && o.requireChecks) return { act: "wait", why: "no CI checks reported yet" };
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

type PendingMerge =
  | { kind: "native"; queue: string; why: string }
  | { kind: "serial"; why: string };

type PendingMerges = Map<string, PendingMerge>;
type Progress = "next" | "restart" | PendingMerge;

interface NativeAdmission {
  ref: PullRequestRef;
  head: string;
  queue: string;
  capacity: number;
}

type ScheduledStep = QueueStep | { act: "enqueue"; admission: NativeAdmission };

export const queueConfig = (main: string): Required<Pick<MergeQueueConfig, "method" | "verifyTimeout" | "cleanup" | "maxUpdates" | "requireChecks">> & MergeQueueConfig => ({
  method: "squash",
  verifyTimeout: 1800,
  cleanup: true,
  maxUpdates: 3,
  requireChecks: existsSync(join(main, ".github", "workflows")),
  ...mainConfig(main).mergeQueue,
});

function nativeAdmission(main: string, c: Checks): NativeAdmission | null {
  const pr = c.pr;
  if (!pr?.ref || !pr.base || !c.head || c.head !== pr.head) return null;
  const ref = pr.ref;
  const current = readGhJson(main, [
    "api", "graphql", "--hostname", ref.host, "-f", `id=${ref.id}`, "-f", `base=${pr.base}`,
    "-f", "query=query($id:ID!,$base:String!){node(id:$id){...on PullRequest{state baseRefName headRefOid repository{mergeQueue(branch:$base){id configuration{maximumEntriesToBuild}}}}}}",
    "--jq", ".data.node",
  ]);
  if (current?.state !== "OPEN" || current.baseRefName !== pr.base || current.headRefOid !== c.head) return null;
  const queue = isObject(current.repository) ? current.repository.mergeQueue : null;
  if (!isObject(queue) || !isObject(queue.configuration)) return null;
  const key = queueKey(ref.host, queue);
  const capacity = queue.configuration.maximumEntriesToBuild;
  if (!key || typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity <= 0) return null;
  return { ref, head: c.head, queue: key, capacity };
}

function schedule(
  main: string, x: Merge, c: Checks, l: Ledger, cfg: ReturnType<typeof queueConfig>, pending: PendingMerges,
): ScheduledStep {
  const next = plan(x, c, { ...cfg, blockedBy: blockedBy(l, x) });
  if (!pending.size) return next;
  const wait: QueueStep = { act: "wait", why: "waiting for in-flight merges" };
  if (next.act === "update" || next.act === "merged_elsewhere") return wait;
  if (next.act !== "merge") return next;
  const waits = [...pending.values()];
  if (cfg.verify || cfg.gc || waits.some((entry) => entry.kind === "serial")) return wait;
  const admission = nativeAdmission(main, c);
  if (!admission) return wait;
  const used = waits.filter((entry) => entry.kind === "native" && entry.queue === admission.queue).length;
  if (used >= admission.capacity) return { act: "wait", why: "GitHub merge queue is at its build capacity" };
  return { act: "enqueue", admission };
}

function pendingMerge(status: MergeStatus, mayOverlap: boolean): PendingMerge {
  if (status.kind === "queued" && mayOverlap) return { kind: "native", queue: status.queue, why: "waiting for the GitHub merge queue" };
  if (status.kind === "queued" || status.kind === "pending") return { kind: "serial", why: "waiting for the GitHub merge queue or auto-merge" };
  return { kind: "serial", why: "can't confirm PR merge status (gh)" };
}

function enqueue(main: string, { ref, head }: NativeAdmission): RunResult {
  return run([
    "gh", "api", "graphql", "--hostname", ref.host, "-f", `id=${ref.id}`, "-f", `head=${head}`,
    "-f", "query=mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id}}}",
  ], { cwd: main });
}

export type PreviewEntry = RunReport["waiting"][number] & { checks?: Checks };

export function* previewQueue(main: string, l: Ledger, observed?: PendingMerges): Generator<PreviewEntry> {
  const cfg = queueConfig(main);
  const items = ordered(l);
  const pending = new Map(observed);
  const inFlight = items.filter((x) => IN_FLIGHT.includes(x.state));
  const inFlightSteps = new Map<string, Step>();
  for (const x of inFlight) {
    const status = observed ? null : mergeStatus(main, x.pr);
    const entry: PendingMerge = pending.get(x.id) ?? (status
      ? pendingMerge(status, x.state === "merging")
      : { kind: "serial", why: `${x.state}: resumes here` });
    pending.set(x.id, entry);
    const step: Step = status?.kind === "merged"
      ? { act: "merged_elsewhere" }
      : status?.kind === "closed"
        ? { act: "return", why: "PR closed before merging" }
        : status?.kind === "open"
          ? { act: "return", why: "PR is open with no pending GitHub merge request" }
          : { act: "wait", why: entry.why };
    inFlightSteps.set(x.id, step);
  }
  for (const x of items) {
    const row = { id: x.id, branch: x.branch, state: x.state };
    const inFlightStep = inFlightSteps.get(x.id);
    if (inFlightStep) {
      yield { ...row, step: inFlightStep };
      continue;
    }
    if (!WAITING.includes(x.state)) continue;
    if (x.state === "waiting_user" && !x.approved) {
      yield { ...row, step: { act: "ask", why: x.why ?? "" } };
      continue;
    }
    const checks = mqChecks(main, x, l);
    const step = schedule(main, x, checks, l, cfg, pending);
    yield { ...row, step: step.act === "enqueue" ? { act: "enqueue" } : step, checks };
    if (step.act !== "enqueue" && step.act !== "merge") continue;
    const admission = step.act === "enqueue" ? step.admission : nativeAdmission(main, checks);
    if (admission) {
      pending.set(x.id, { kind: "native", queue: admission.queue, why: "scheduled for the GitHub merge queue" });
    }
  }
}

function tail(s: string, n = 20): string {
  return s.trim().split("\n").slice(-n).join("\n");
}

/** Drain the queue: see the file comment. Returns what happened and what still waits. */
export function runQueue(main: string, o: RunOptions): RunReport {
  const cfg = queueConfig(main);
  const m = messages(langFor(main));
  // Batching only changes anything with a deploy check: without one, each merge is cleaned up as it lands.
  const batchMax = cfg.batch === true ? Infinity : typeof cfg.batch === "number" && cfg.batch > 1 ? cfg.batch : 0;
  const batching = batchMax > 0 && !!cfg.verify;
  const report: RunReport = { events: [], merged: [], waiting: [], unblocked_tasks: [] };
  if (o.dryRun) report.dry_run = true;

  /** Change one item in the ledger (under its lock) and log the move. */
  const moveItem = (id: string, to: MergeState, why: string | null, change?: (x: Merge) => void) => {
    updateLedger(main, (l) => {
      const x = (l.merges ?? []).find((y) => y.id === id);
      if (!x) return;
      const from = x.state;
      change?.(x);
      // A repeat (updated again while updating) is a step too: it goes in the history and the report.
      move(x, to, o.by, why);
      report.events.push({ id, branch: x.branch, from, to, why });
    });
  };

  /**
   * Give the working session (if live) what came back to it, in full. Its main gets one line in its log (not in
   * front of it: the working session handles it), or nothing with toMain false.
   */
  const giveBack = (x: Merge, text: string, toMain = true) => {
    const agent = herdr.terminals().find((t) => herdr.isLive(t) && herdr.isAgent(t) && herdr.inDir(t, x.path))?.address;
    if (agent) herdr.send(agent, text);
    const owner = toMain ? ownerOf(readLedger(main), x.branch) : null;
    if (owner) notifyMain(main, owner, { branch: x.branch, path: x.path, text: text.split("\n")[0]!, wake: false });
  };

  const fetch = () => {
    if (hasOrigin(main)) run(["git", "fetch", "-q", "--prune", "origin"], { cwd: main });
  };

  /** The deploy check for these merges (oldest first): null when it passed, else why and the log's tail. */
  const verify = (xs: Merge[]): { why: string; log: string } | null => {
    const last = xs.at(-1)!;
    const all = (f: (y: Merge) => string) => xs.map(f).join(" ");
    const r = Bun.spawnSync({
      cmd: ["sh", "-c", cfg.verify!],
      cwd: main,
      env: {
        ...process.env, HWT_MQ_ID: last.id, HWT_MQ_BRANCH: last.branch, HWT_MQ_PR: String(last.pr ?? ""), HWT_MQ_SHA: last.sha ?? "",
        HWT_MQ_IDS: all((y) => y.id), HWT_MQ_BRANCHES: all((y) => y.branch), HWT_MQ_PRS: all((y) => String(y.pr ?? "")),
        HWT_MQ_SHAS: all((y) => y.sha ?? ""),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: cfg.verifyTimeout * 1000,
    });
    if (r.exitCode === 0) return null;
    return { why: `deploy check failed (exit ${r.exitCode ?? "timeout"})`, log: tail(`${r.stdout.toString()}\n${r.stderr.toString()}`) };
  };

  /** Merged: record it, then (unless batching, which checks later) the deploy check and cleanup. */
  const finish = (x: Merge, sha: string, why: string | null): "done" | "deferred" => {
    const { id } = x;
    const verified = x.state === "cleaning" && x.sha === sha;
    if (!verified && (x.state !== "verifying" || x.sha !== sha)) {
      moveItem(id, "verifying", why, (y) => { y.sha = sha; });
      if (x.state !== "verifying" && x.state !== "cleaning") report.merged.push(x.branch);
    }
    if (!verified && cfg.verify) {
      if (batching) return "deferred";
      const failed = verify([{ ...x, sha }]);
      if (failed) {
        moveItem(id, "failed", failed.why);
        giveBack(x, `${m.tags.deployFailed} ${id} ${x.branch}: ${failed.why}\n${failed.log}`);
        return "done";
      }
    }
    cleanUp(x);
    return "done";
  };

  /** One deploy check for every merged item waiting for one, then cleanup. False when there were none. */
  const verifyBatch = (): boolean => {
    fetch();
    const xs = ordered(readLedger(main)).filter((y) => y.state === "verifying" && y.sha);
    if (!xs.length) return false;
    // Oldest merge first: an earlier merge is an ancestor of a later one.
    const before = (a: Merge, b: Merge) => run(["git", "merge-base", "--is-ancestor", a.sha!, b.sha!], { cwd: main }).ok;
    xs.sort((a, b) => (a.sha === b.sha ? 0 : before(a, b) ? -1 : before(b, a) ? 1 : 0));
    const failed = verify(xs);
    if (!failed) {
      for (const x of xs) cleanUp(x);
      return true;
    }
    const why = xs.length > 1 ? `${failed.why} for ${xs.length} merged together: ${xs.map((y) => y.branch).join(", ")}` : failed.why;
    const owners = new Set<string>();
    for (const x of xs) {
      moveItem(x.id, "failed", why);
      giveBack(x, `${m.tags.deployFailed} ${x.id} ${x.branch}: ${why}\n${failed.log}`, false);
      const owner = ownerOf(readLedger(main), x.branch);
      if (owner) owners.add(owner);
    }
    // The person decides which one broke it: every owning main hears it (once), awake.
    for (const owner of owners) {
      notifyMain(main, owner, { branch: xs.at(-1)!.branch, path: main, text: `${m.tags.deployFailed} ${why}`, wake: true });
    }
    return true;
  };

  /** After a passed (or no) deploy check: remove the worktree, gc, fast-forward, close the task. */
  /** Done: the owning main hears it (awake), so it never has to wait or poll for a merge. */
  const done = (x: Merge, why: string | null) => {
    moveItem(x.id, "done", why);
    const owner = ownerOf(readLedger(main), x.branch);
    const text = `${m.tags.merged} ${x.id} ${x.branch}${x.pr ? ` PR #${x.pr}` : ""}${why ? ` (${why})` : ""}`;
    // A main that ran the runner itself has the result in its output already.
    if (owner && owner !== o.by) notifyMain(main, owner, { branch: x.branch, path: main, text, wake: true });
  };

  const cleanUp = (x: Merge): void => {
    const { id } = x;
    const verified = x.state === "cleaning";
    if (!cfg.cleanup) {
      done(x, null);
      return;
    }
    if (!verified) moveItem(id, "cleaning", null);
    const l = readLedger(main);
    const notes: string[] = [];
    const w = l.worktrees[x.branch];
    const ownMain = !!w?.self_main;
    if (ownMain) notes.push("worktree kept: its session is a main of its own");
    else if (w?.state === "active" && w.hold) notes.push(`worktree kept: on hold (${w.hold}); hwt rm --release-hold once the person says so`);
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
    const previouslyUnblocked = report.unblocked_tasks.length;
    updateLedger(main, (l2) => {
      for (const t of l2.tasks ?? []) {
        if (t.branch === x.branch && t.state === "running") Object.assign(t, { state: "done", closed: stamp() });
        if (t.state === "decided" && t.decision === `after:${x.branch}`) report.unblocked_tasks.push({ id: t.id, title: t.title, owner: t.owner ?? null });
      }
    });
    for (const t of report.unblocked_tasks.slice(previouslyUnblocked).filter((t) => t.owner)) {
      notifyMain(main, t.owner!, { branch: x.branch, path: main, text: `${m.tags.unblocked} ${t.id} ${t.title} (after:${x.branch} merged)`, wake: true });
    }
    done(x, notes.join("; ") || null);
  };

  const giveBackMerge = (x: Merge, why: string, rebase = false) => {
    moveItem(x.id, "returned", why);
    giveBack(x, `${rebase ? m.tags.rebaseRequest : m.tags.returned} ${x.id} ${x.branch}: ${why}. ${m.requeue}`);
  };

  const reconcile = (x: Merge, submission?: { result: RunResult; command: string }): Progress => {
    const status = mergeStatus(main, x.pr);
    switch (status.kind) {
      case "merged":
        if (finish(x, status.sha, null) === "deferred") {
          fetch(); // the next item's checks see this merge on the base
          return "next";
        }
        return "restart";
      case "queued":
      case "pending":
      case "unknown":
        return pendingMerge(status, x.state === "merging" || !!submission);
      case "closed":
        giveBackMerge(x, "PR closed before merging");
        return "next";
      case "open":
        if (submission?.result.ok) return { kind: "serial", why: "waiting for GitHub to confirm the merge request" };
        if (submission) moveItem(x.id, "queued", `${submission.command} failed: ${tail(submission.result.err || submission.result.out, 3)}`);
        else giveBackMerge(x, "PR is open with no pending GitHub merge request");
        return "next";
    }
  };

  const step = (x: Merge, s: ScheduledStep): Progress => {
    switch (s.act) {
      case "merge": {
        moveItem(x.id, "merging", null);
        const r = run(["gh", "pr", "merge", String(x.pr), `--${cfg.method}`], { cwd: main });
        return reconcile(x, { result: r, command: "gh pr merge" });
      }
      case "enqueue": {
        moveItem(x.id, "merging", null);
        return reconcile(x, { result: enqueue(main, s.admission), command: "GitHub merge queue admission" });
      }
      case "merged_elsewhere": {
        const status = mergeStatus(main, x.pr);
        if (status.kind !== "merged") return { kind: "serial", why: "can't confirm PR merge status (gh)" };
        if (finish(x, status.sha, "merged outside the queue") === "deferred") {
          fetch();
          return "next";
        }
        return "restart";
      }
      case "update": {
        const r = run(["gh", "pr", "update-branch", String(x.pr)], { cwd: main });
        if (!r.ok) {
          moveItem(x.id, "returned", `gh pr update-branch failed: ${tail(r.err || r.out, 3)}`);
          giveBack(x, `${m.tags.rebaseRequest} ${x.id} ${x.branch}: ${s.why}; couldn't update it here, rebase and push, then hwt mq add again`);
          return "next";
        }
        moveItem(x.id, "updating", s.why, (y) => {
          y.updates = (y.updates ?? 0) + 1;
        });
        giveBack(x, `${m.tags.baseUpdated} ${x.id} ${x.branch}: ${m.baseUpdated}`, false);
        return "next";
      }
      case "return":
        giveBackMerge(x, s.why, s.rebase);
        return "next";
      case "ask":
        if (x.state !== "waiting_user") {
          moveItem(x.id, "waiting_user", s.why);
          const owner = ownerOf(readLedger(main), x.branch);
          const text = `${m.tags.approval} ${x.id} ${x.branch}${x.pr ? ` PR #${x.pr}` : ""}: ${s.why} — hwt mq approve ${x.id}`;
          if (owner) notifyMain(main, owner, { branch: x.branch, path: x.path, text, wake: true });
          else warn(text);
        }
        return "next";
      case "drop":
        moveItem(x.id, "dropped", s.why);
        return "next";
      case "wait":
      case "blocked":
        // Stays in line. updating → queued once CI has picked the update up is not needed: plan reads CI.
        return "next";
    }
  };

  /** One pass over the line: in-flight items first (a crashed runner left them), then in order. */
  const pass = (): PendingMerges | "restart" => {
    fetch();
    let l = readLedger(main);
    const pending: PendingMerges = new Map();
    let finalized = false;
    for (const x of ordered(l).filter((y) => IN_FLIGHT.includes(y.state))) {
      const progress = reconcile(x);
      if (progress === "restart") finalized = true;
      else if (progress !== "next") pending.set(x.id, progress);
    }
    if (finalized) return "restart";
    l = readLedger(main);
    let merges = 0;
    for (const x of ordered(l).filter((y) => y.state === "queued" || y.state === "updating" || y.state === "waiting_user")) {
      if (x.state === "waiting_user" && !x.approved) continue;
      const c = mqChecks(main, x, readLedger(main));
      let s = schedule(main, x, c, readLedger(main), cfg, pending);
      if (batching && s.act === "merge" && merges >= batchMax) s = { act: "wait", why: `batch is full (${batchMax})` };
      if (s.act === "merge") merges++;
      const progress = step(x, s);
      if (progress === "restart") return progress;
      if (progress !== "next") pending.set(x.id, progress);
    }
    // Batching: everything merged in this pass (and any left verifying) gets one deploy check now.
    if (batching && verifyBatch()) return "restart";
    return pending;
  };

  const leftover = (pending?: PendingMerges) => {
    fetch();
    report.waiting = Array.from(previewQueue(main, readLedger(main), pending),
      ({ id, branch, state, step }) => ({ id, branch, state, step }));
  };

  if (o.dryRun) {
    leftover();
    return report;
  }
  acquireLease(main, o.by);
  let pending: PendingMerges = new Map();
  try {
    const end = Date.now() + o.timeout * 1000;
    for (;;) {
      beat(main);
      const progress = pass();
      if (progress === "restart") continue;
      pending = progress;
      const l = readLedger(main);
      const inLine = (l.merges ?? []).some((x) => x.state === "queued" || x.state === "updating" || (x.state === "waiting_user" && x.approved));
      if (!o.watch || (!pending.size && !inLine) || Date.now() >= end) break;
      sleepMs(Math.min(o.interval * 1000, Math.max(0, end - Date.now())));
    }
  } finally {
    releaseLease(main);
  }
  leftover(pending);
  return report;
}
