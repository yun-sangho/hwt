// Settings, in three layers: built-in defaults < user config (~/.config/hwt/config.json) < repo (.hwt.json).
// Environment variables win over all of them (HWT_ROOT, HWT_AGENT, HWT_LANG).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, warn } from "./util.ts";

export type Lang = "en" | "ko";

export interface MergeApproval {
  /** Globs (Bun.Glob): touching any of these needs the user's yes before merging. */
  paths?: string[];
  /** More changed lines than this needs the user's yes. 0 or unset: no limit. */
  maxLines?: number;
}

/** How `hwt mq run` merges, checks the deploy and cleans up. */
export interface MergeQueueConfig {
  /** gh pr merge method. Default "squash". */
  method?: "squash" | "merge" | "rebase";
  /** Branch PRs merge into, when a PR doesn't say. Default: origin's HEAD, else the main checkout's branch. */
  base?: string;
  /** Deploy check run in the main checkout after the merge (sh -c). Exit 0 = passed. Env: HWT_MQ_ID, _BRANCH, _PR, _SHA. */
  verify?: string;
  /** Seconds the deploy check may take. Default 1800. */
  verifyTimeout?: number;
  /** The repo's gc, run in the main checkout after the worktree is removed (sh -c). */
  gc?: string;
  /** Remove the worktree, its agent and its branches after a verified merge. Default true. */
  cleanup?: boolean;
  /** Times the runner brings a PR up to date with its base before returning it. Default 3. */
  maxUpdates?: number;
  /**
   * A PR with no CI checks reported waits instead of merging. Default: true when the repo has
   * .github/workflows (right after a push, GitHub shows no checks until CI starts).
   */
  requireChecks?: boolean;
}

/** .hwt.json at the repo root. */
export interface RepoConfig {
  version?: number;
  /** Runs once in a checkout `hwt new` creates, before the agent starts. */
  setup?: string;
  /** Main-session workflow: new/rm only from the main checkout, ledger, inbox, merge queue. */
  mainSession?: boolean;
  mergeApproval?: MergeApproval;
  mergeQueue?: MergeQueueConfig;
  /** Default agent command for `hwt new` in this repo. */
  agent?: string;
  /** Language of the instructions hwt gives agents and of its message tags. */
  lang?: Lang;
}

/** ~/.config/hwt/config.json */
export interface UserConfig {
  /** Where checkouts go: <root>/<repo>/<branch slug>. Default: Herdr's worktrees.directory, else ~/.herdr/worktrees. */
  root?: string;
  agent?: string;
  lang?: Lang;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    warn(`can't read ${path}`);
    return null;
  }
}

export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "hwt", "config.json");
}

export function userConfig(): UserConfig {
  return readJson<UserConfig>(userConfigPath()) ?? {};
}

/** The main checkout's .hwt.json. Only this copy decides mainSession and mergeApproval. */
export function mainConfig(main: string): RepoConfig {
  return readJson<RepoConfig>(join(main, ".hwt.json")) ?? {};
}

/** A checkout's own .hwt.json if it has one, else the main checkout's (for setup). */
export function checkoutConfig(wt: string, main: string): RepoConfig {
  return readJson<RepoConfig>(join(wt, ".hwt.json")) ?? mainConfig(main);
}

/** Herdr's own New worktree destination, so hwt checkouts land next to the ones made in the app. */
function herdrWorktreesDir(): string | null {
  const home = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
  const s = readJson<{ worktrees?: { directory?: string } }>(join(home, "settings.json"));
  return s?.worktrees?.directory ?? null;
}

export function worktreesRoot(): string {
  return expandHome(process.env.HWT_ROOT || userConfig().root || herdrWorktreesDir() || "~/.herdr/worktrees");
}

export function langFor(main: string | null): Lang {
  const l = process.env.HWT_LANG || (main ? mainConfig(main).lang : undefined) || userConfig().lang || "en";
  return l === "ko" ? "ko" : "en";
}

export function defaultAgent(main: string): string {
  return process.env.HWT_AGENT || mainConfig(main).agent || userConfig().agent || "claude";
}
