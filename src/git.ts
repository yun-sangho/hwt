// Git queries. Every hwt command runs from inside a checkout of the repo (main or linked).
import { realpathSync } from "node:fs";
import { die, run, runOut } from "./util.ts";

export function git(args: string[], cwd?: string) {
  return run(["git", ...args], { cwd });
}

export function gitOut(args: string[], cwd?: string): string | null {
  return runOut(["git", ...args], { cwd });
}

/** Absolute path of the main checkout (the common git dir's parent). */
export function repoMain(cwd = process.cwd()): string {
  const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (!common) die("not in a git repository");
  return common.replace(/\/\.git\/?$/, "");
}

export function commonGitDir(main: string): string {
  const d = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], main);
  if (!d) die(`not a git repository: ${main}`);
  return d;
}

export function toplevel(cwd = process.cwd()): string | null {
  return gitOut(["rev-parse", "--show-toplevel"], cwd);
}

export function currentBranch(cwd = process.cwd()): string {
  return gitOut(["branch", "--show-current"], cwd) ?? "";
}

export function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && realpath(a) === realpath(b);
}

export interface WorktreeEntry {
  path: string;
  branch: string;
}

export function worktreeList(main: string): WorktreeEntry[] {
  const out = gitOut(["worktree", "list", "--porcelain"], main) ?? "";
  const list: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) list.push(cur);
      cur = { path: line.slice(9), branch: "" };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
  }
  if (cur) list.push(cur);
  return list;
}

export function isDirty(dir: string): boolean {
  return (gitOut(["status", "--porcelain"], dir) ?? "") !== "";
}

/** Paths a worktree touches: committed since it left the main branch, plus uncommitted ones. */
export function touchedPaths(wt: string, main: string): string[] {
  const set = new Set<string>();
  const mb = currentBranch(main);
  const base = mb ? gitOut(["merge-base", "HEAD", mb], wt) : null;
  if (base) for (const f of (gitOut(["diff", "--name-only", base], wt) ?? "").split("\n")) if (f) set.add(f);
  for (const l of (gitOut(["status", "--porcelain"], wt) ?? "").split("\n")) if (l.length > 3) set.add(l.slice(3));
  return [...set].sort();
}
