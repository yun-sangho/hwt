// The built-in deploy check (mergeQueue.deploy): after merges, wait for the push runs on every merged commit to
// finish. A run that finished is a deploy that finished: there is no separate check of the site.
//
//   runs       per merged commit (oldest first): the newest push run of each listed workflow, or with no list, of
//              every workflow that ran on it. Each must finish with success (or skipped).
//              A listed workflow's run must appear (a workflow filtered by paths at the trigger never runs: list
//              only workflows that always run). With no list, a commit with no runs at all deployed nothing.
//   cancelled  GitHub keeps one pending run per concurrency group: a later push cancels the pending one. Its
//              commit's changes then ship only if the later run deploys everything since the last deploy, not just
//              its own push's diff. So a cancelled run fails the check, unless `cancelledOk` says the workflows
//              deploy that way. The newest commit's runs must always succeed.
import { run, sleepMs } from "./util.ts";

export interface DeployConfig {
  /** Workflow files (deploy.yml) or names whose push run on the merge commit is the deploy. Omitted: every push run. */
  workflows?: string[];
  /** The workflows deploy everything since the last successful deploy, so a cancelled run is covered by a later one. */
  cancelledOk?: boolean;
}

export interface DeployTarget {
  sha: string;
  branch: string;
  pr: number | null;
}

interface Run {
  databaseId: number;
  status: string;
  conclusion: string;
  url: string;
  workflowName?: string;
}

const pollMs = () => Number(process.env.HWT_DEPLOY_POLL_MS) || 15_000;
const appearMs = () => Number(process.env.HWT_DEPLOY_APPEAR_MS) || 5 * 60_000;

/** The push runs on <sha> (of <workflow>, or of every workflow), the newest per workflow. */
function findRuns(main: string, sha: string, workflow?: string): Run[] | "error" {
  const r = run(
    ["gh", "run", "list", ...(workflow ? ["--workflow", workflow] : []), "--commit", sha, "--event", "push", "--json", "databaseId,status,conclusion,url,workflowName"],
    { cwd: main },
  );
  if (!r.ok) return "error";
  try {
    const newest = new Map<string, Run>();
    for (const x of (JSON.parse(r.out) as Run[]).sort((a, b) => b.databaseId - a.databaseId)) {
      const key = workflow ?? x.workflowName ?? String(x.databaseId);
      if (!newest.has(key)) newest.set(key, x);
    }
    return [...newest.values()];
  } catch {
    return "error";
  }
}

/** null when every deploy run finished well; else why, and lines for the log. */
export function checkDeploy(
  main: string, d: DeployConfig, targets: DeployTarget[], timeoutS: number, undeployed?: Set<string>,
): { why: string; log: string } | null {
  const end = Date.now() + timeoutS * 1000;
  const appearBy = Date.now() + appearMs();
  const newest = targets.at(-1)!;
  const name = (t: DeployTarget) => `${t.branch}${t.pr ? ` (PR #${t.pr})` : ""} ${t.sha.slice(0, 7)}`;
  const listed = d.workflows?.length ? d.workflows : null;
  // Per commit, per workflow (a listed one, or "" for every workflow): its runs, once seen.
  const open = targets.flatMap((t) => (listed ?? [""]).map((w) => ({ t, w, runs: null as Run[] | null })));
  const finished = (p: (typeof open)[number]) => !!p.runs && p.runs.every((x) => x.status === "completed");
  for (;;) {
    let errors = 0;
    for (const p of open) {
      if (finished(p) && p.runs!.length) continue;
      const r = findRuns(main, p.t.sha, p.w || undefined);
      if (r === "error") errors++;
      else if (r.length) p.runs = r;
    }
    const pastAppear = Date.now() >= appearBy;
    // With no list, a commit with no runs once the wait is over had nothing to deploy.
    if (!listed && pastAppear) for (const p of open) p.runs ??= [];
    const missing = open.filter((p) => !p.runs);
    const running = open.filter((p) => p.runs && !finished(p));
    if (!missing.length && !running.length) break;
    if (Date.now() >= end) {
      const lines = running.flatMap((p) => p.runs!.filter((x) => x.status !== "completed").map((x) => `${x.workflowName ?? p.w} ${name(p.t)}: ${x.status} ${x.url}`));
      return { why: `deploy didn't finish in ${timeoutS}s`, log: lines.join("\n") };
    }
    if (missing.length && pastAppear) {
      const what = missing.map((p) => `${p.w} for ${name(p.t)}`).join(", ");
      return { why: `no deploy run appeared: ${what}${errors ? " (gh failed)" : ""}`, log: "a workflow that skips some pushes at the trigger (on.push.paths) can't be checked this way; list only workflows that always run, or leave workflows out" };
    }
    sleepMs(pollMs());
  }
  const log: string[] = [];
  for (const p of open) {
    for (const r of p.runs!) {
      const line = `${r.workflowName ?? p.w} ${name(p.t)}: ${r.conclusion} ${r.url}`;
      log.push(line);
      if (r.conclusion === "success" || r.conclusion === "skipped") continue;
      if (r.conclusion === "cancelled" && p.t !== newest) {
        if (d.cancelledOk) continue;
        return {
          why: `the deploy of ${p.t.branch} was cancelled by a later push; its changes may not be deployed (set mergeQueue.deploy.cancelledOk once the workflow deploys everything since the last deploy)`,
          log: log.join("\n"),
        };
      }
      return { why: `deploy ${r.conclusion}: ${r.workflowName ?? p.w} for ${p.t.branch}`, log: `${line}\nlog: gh run view ${r.databaseId} --log-failed` };
    }
  }
  // A commit whose runs were all skipped (or that had none) deployed nothing: there is nothing live to check for it.
  for (const t of targets) {
    if (open.filter((p) => p.t === t).every((p) => p.runs!.every((x) => x.conclusion === "skipped"))) undeployed?.add(t.sha);
  }
  return null;
}
