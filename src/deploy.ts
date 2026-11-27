// The built-in deploy check (mergeQueue.deploy): after merges, wait for the push runs of the deploy workflows on
// every merged commit, then for the site URLs to answer. Used in place of a repo's own verify script.
//
//   runs       per workflow and merged commit (oldest first): the newest push run on that commit. It must appear
//              (a workflow filtered by paths at the trigger never runs: list only workflows that always run) and
//              finish with success.
//   cancelled  GitHub keeps one pending run per concurrency group: a later push cancels the pending one. Its
//              commit's changes then ship only if the later run deploys everything since the last deploy, not just
//              its own push's diff. So a cancelled run fails the check, unless `cancelledOk` says the workflows
//              deploy that way. The newest commit's run must always succeed.
//   urls       each must answer (curl -fsSL, so 4xx/5xx fail), with a few retries.
import { run, sleepMs } from "./util.ts";

export interface DeployConfig {
  /** Workflow files (deploy.yml) or names whose push run on the merge commit is the deploy. */
  workflows: string[];
  /** URLs that must answer after the deploy. */
  urls?: string[];
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
}

const pollMs = () => Number(process.env.HWT_DEPLOY_POLL_MS) || 15_000;
const appearMs = () => Number(process.env.HWT_DEPLOY_APPEAR_MS) || 5 * 60_000;
const urlTries = () => Number(process.env.HWT_DEPLOY_URL_TRIES) || 5;

function findRun(main: string, workflow: string, sha: string): Run | null | "error" {
  const r = run(["gh", "run", "list", "--workflow", workflow, "--commit", sha, "--event", "push", "--json", "databaseId,status,conclusion,url"], { cwd: main });
  if (!r.ok) return "error";
  try {
    const runs = JSON.parse(r.out) as Run[];
    return runs.sort((a, b) => b.databaseId - a.databaseId)[0] ?? null;
  } catch {
    return "error";
  }
}

/** null when every deploy ran and the site answers; else why, and lines for the log. */
export function checkDeploy(main: string, d: DeployConfig, targets: DeployTarget[], timeoutS: number): { why: string; log: string } | null {
  const end = Date.now() + timeoutS * 1000;
  const appearBy = Date.now() + appearMs();
  const log: string[] = [];
  const newest = targets.at(-1)!;
  const name = (t: DeployTarget) => `${t.branch}${t.pr ? ` (PR #${t.pr})` : ""} ${t.sha.slice(0, 7)}`;
  // Every (workflow, commit) pair, until each has finished.
  const open = targets.flatMap((t) => d.workflows.map((w) => ({ t, w, run: null as Run | null })));
  for (;;) {
    let errors = 0;
    for (const p of open) {
      if (p.run?.status === "completed") continue;
      const r = findRun(main, p.w, p.t.sha);
      if (r === "error") errors++;
      else if (r) p.run = r;
    }
    const missing = open.filter((p) => !p.run);
    const running = open.filter((p) => p.run && p.run.status !== "completed");
    if (!missing.length && !running.length) break;
    if (Date.now() >= end) {
      return { why: `deploy didn't finish in ${timeoutS}s`, log: [...running.map((p) => `${p.w} ${name(p.t)}: ${p.run!.status} ${p.run!.url}`), ...log].join("\n") };
    }
    if (missing.length && Date.now() >= appearBy) {
      const what = missing.map((p) => `${p.w} for ${name(p.t)}`).join(", ");
      return { why: `no deploy run appeared: ${what}${errors ? " (gh failed)" : ""}`, log: "a workflow that skips some pushes at the trigger (on.push.paths) can't be checked this way; list only workflows that always run" };
    }
    sleepMs(pollMs());
  }
  for (const p of open) {
    const r = p.run!;
    const line = `${p.w} ${name(p.t)}: ${r.conclusion} ${r.url}`;
    log.push(line);
    if (r.conclusion === "success" || r.conclusion === "skipped") continue;
    if (r.conclusion === "cancelled" && p.t !== newest) {
      if (d.cancelledOk) continue;
      return {
        why: `the deploy of ${p.t.branch} was cancelled by a later push; its changes may not be deployed (set mergeQueue.deploy.cancelledOk once the workflow deploys everything since the last deploy)`,
        log: log.join("\n"),
      };
    }
    return { why: `deploy ${r.conclusion}: ${p.w} for ${p.t.branch}`, log: `${line}\nlog: gh run view ${r.databaseId} --log-failed` };
  }
  for (const url of d.urls ?? []) {
    let last = "";
    for (let i = 1; ; i++) {
      const r = run(["curl", "-fsSL", "-o", "/dev/null", "--max-time", "15", "-w", "%{http_code}", url]);
      if (r.ok) {
        log.push(`${url} ${r.out.trim()}`);
        break;
      }
      last = `${r.out.trim() || "no answer"} ${r.err.trim()}`.trim();
      if (i >= urlTries()) return { why: `deploy ran, but ${url} → ${last}`, log: log.join("\n") };
      sleepMs(Math.min(10_000, pollMs()));
    }
  }
  return null;
}
