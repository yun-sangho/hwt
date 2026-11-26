// Where hwt works. In a git repo, the project is the main checkout and each child session gets its own worktree.
// In any other folder, children open in that folder (or a --dir) without a checkout: they share the files, and
// hwt tells them apart by the HWT_CHILD it starts them with and by their terminals.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { currentBranch, gitOut, realpath, repoMain, samePath, toplevel } from "./git.ts";
import * as herdr from "./herdr.ts";
import type { Ledger, WorktreeRecord } from "./ledger.ts";
import { sessionFromEnv } from "./agents.ts";
import { basename, die, slug } from "./util.ts";

const gitCache = new Map<string, boolean>();

/** Whether <dir> is inside a git repo. */
export function isGit(dir: string): boolean {
  let v = gitCache.get(dir);
  if (v === undefined) {
    v = !!gitOut(["rev-parse", "--git-common-dir"], dir);
    gitCache.set(dir, v);
  }
  return v;
}

/** The nearest folder from <dir> up that has a .hwt.json. */
function configured(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".hwt.json"))) return d;
    if (dirname(d) === d) return null;
  }
}

/**
 * The project root: the main checkout in a git repo; elsewhere HWT_PROJECT (a child started by hwt has it),
 * else the nearest folder with a .hwt.json, else the current folder.
 */
export function projectRoot(cwd = process.cwd()): string {
  if (isGit(cwd)) return repoMain(cwd);
  const env = process.env.HWT_PROJECT;
  if (env && existsSync(env)) return realpath(env);
  return configured(realpath(cwd)) ?? realpath(cwd);
}

/** Where the ledger lives: <git common dir>/hwt, or for a folder, ~/.local/state/hwt/projects/<name>-<hash>. */
export function stateDirFor(root: string, create = true): string {
  let d: string;
  if (isGit(root)) {
    const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], root);
    if (!common) die(`not a git repository: ${root}`);
    d = join(common, "hwt");
  } else {
    const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    const hash = createHash("sha256").update(realpath(root)).digest("hex").slice(0, 10);
    d = join(base, "hwt", "projects", `${slug(basename(root)) || "root"}-${hash}`);
  }
  if (create) mkdirSync(d, { recursive: true });
  return d;
}

export function requireGit(root: string, what: string): void {
  if (!isGit(root)) die(`${what} needs a git repository (${root} is a plain folder)`);
}

/**
 * The ledger key of the child session this caller is, or "" for a main (or anyone else). In a git repo: the
 * branch of the linked worktree it is in. In a folder: HWT_CHILD, else the record with this terminal or session.
 */
export function childKey(root: string, l: Ledger): string {
  const env = process.env.HWT_CHILD;
  if (env && l.worktrees[env]) return env;
  if (isGit(root)) {
    const top = toplevel();
    return top && !samePath(top, root) ? currentBranch() : "";
  }
  const t = herdr.myTerminal();
  const s = sessionFromEnv();
  const hit = Object.entries(l.worktrees).find(
    ([, w]) => w.state === "active" && ((!!t && w.terminal === t) || (!!s && w.session === s)),
  );
  return hit?.[0] ?? "";
}

/** The folder the caller works in: its worktree or child folder, else the git checkout or current folder. */
export function workDir(root: string, l: Ledger): string {
  const k = childKey(root, l);
  if (!isGit(root) && k) return l.worktrees[k]?.path ?? root;
  return toplevel() ?? realpath(process.cwd());
}

/** A child by key (branch or name), worktree folder name, or path. */
export function findChild(l: Ledger, target: string): [string, WorktreeRecord] | null {
  if (l.worktrees[target]) return [target, l.worktrees[target]!];
  const p = existsSync(target) && target.includes("/") ? realpath(target) : null;
  const hits = Object.entries(l.worktrees).filter(
    ([, w]) => w.state === "active" && (w.name === target || basename(w.path) === target || (!!p && samePath(w.path, p))),
  );
  return hits.length === 1 ? hits[0]! : null;
}
