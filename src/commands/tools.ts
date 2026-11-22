// hwt init / doctor / shell-init / hook session-start
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../args.ts";
import { langFor, mainConfig, userConfigPath, worktreesRoot, type RepoConfig } from "../config.ts";
import { currentBranch, gitOut, repoMain, samePath, toplevel } from "../git.ts";
import * as herdr from "../herdr.ts";
import { readLedger, stateDir, unackedInbox } from "../ledger.ts";
import { messages, selfCommand } from "../messages.ts";
import { claimMain, isMainSessionRepo } from "../session.ts";
import { basename, die, has, printJson, run, runOut } from "../util.ts";

const INIT_USAGE = "hwt init [--main-session] [--setup CMD] [--lang en|ko] [--force]";

/** A setup command guessed from the lockfile in the repo root. */
function guessSetup(dir: string): string | undefined {
  const pick: [string, string][] = [
    ["pnpm-lock.yaml", "pnpm install"],
    ["bun.lock", "bun install"],
    ["bun.lockb", "bun install"],
    ["yarn.lock", "yarn install"],
    ["package-lock.json", "npm ci"],
    ["uv.lock", "uv sync"],
    ["poetry.lock", "poetry install"],
    ["Gemfile.lock", "bundle install"],
    ["go.sum", "go mod download"],
  ];
  return pick.find(([f]) => existsSync(join(dir, f)))?.[1];
}

export function cmdInit(args: string[]): void {
  const a = parse(args, { opts: ["setup", "lang"], flags: ["main-session", "force"] }, INIT_USAGE);
  const top = toplevel() ?? die("not in a git repository");
  const main = repoMain();
  if (!samePath(top, main)) die("run hwt init in the main checkout");
  const f = join(main, ".hwt.json");
  if (existsSync(f) && !a.flag.force) die(`${f} exists (pass --force to rewrite it)`);
  const cfg: RepoConfig = { version: 1 };
  const setup = a.opt.setup ?? guessSetup(main);
  if (setup) cfg.setup = setup;
  if (a.flag["main-session"]) {
    cfg.mainSession = true;
    cfg.mergeApproval = { paths: [".github/workflows/**", ".hwt.json"], maxLines: 400 };
  }
  if (a.opt.lang) {
    if (a.opt.lang !== "en" && a.opt.lang !== "ko") die("--lang is en or ko");
    cfg.lang = a.opt.lang;
  }
  writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
  printJson({ written: f, config: cfg });
}

interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

function version(cmd: string[]): string | null {
  return runOut(cmd)?.split("\n")[0]?.trim() ?? null;
}

export function cmdDoctor(): void {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, required: boolean, detail: string) => checks.push({ name, ok, required, detail });

  const gv = version(["git", "--version"]);
  const m = gv?.match(/(\d+)\.(\d+)/);
  const gitOk = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38));
  add("git", gitOk, true, gv ? `${gv}${gitOk ? "" : " (need 2.38+ for merge-tree --write-tree)"}` : "not found");

  add("herdr-app", has("herdr-app"), true, version(["herdr-app", "--version"]) ?? "not found");
  add("hc", has("hc"), true, version(["hc", "--version"]) ?? "not found");
  add("herdr running", herdr.herdrUp(), false, herdr.herdrUp() ? "window reachable" : "not running: hwt new needs it (or --no-space)");

  if (has("gh")) {
    const auth = run(["gh", "auth", "status"]).ok;
    add("gh", auth, false, auth ? "logged in: merge queue checks PRs and CI" : "not logged in: merge queue skips PR and CI checks");
  } else add("gh", false, false, "not found: merge queue skips PR and CI checks, status --prs is empty");

  for (const agent of ["claude", "codex"]) {
    add(agent, has(agent), false, has(agent) ? (version([agent, "--version"]) ?? "found") : "not found");
  }
  add("worktrees root", true, false, worktreesRoot());
  add("user config", true, false, existsSync(userConfigPath()) ? userConfigPath() : `${userConfigPath()} (none, defaults)`);

  const top = toplevel();
  if (top) {
    const main = repoMain();
    const f = join(main, ".hwt.json");
    let detail = "none (defaults; hwt init writes one)";
    let ok = true;
    if (existsSync(f)) {
      try {
        const c = JSON.parse(readFileSync(f, "utf8")) as RepoConfig & { teardown?: string };
        detail = `${f}: ${c.mainSession ? "main-session workflow" : "worktrees only"}${c.setup ? `, setup: ${c.setup}` : ""}`;
        if (c.teardown) {
          ok = false;
          detail += `; "teardown" is ignored (hwt rm doesn't run it): reclaim with the repo's gc after rm`;
        }
      } catch (e) {
        ok = false;
        detail = `${f}: ${e}`;
      }
    }
    add("repo config", ok, false, detail);
    try {
      const l = readLedger(main);
      add("ledger", true, false, `${stateDir(main)}: ${Object.keys(l.worktrees).length} worktrees, ${(l.tasks ?? []).length} tasks, ${unackedInbox(main).length} unread`);
    } catch (e) {
      add("ledger", false, false, String(e));
    }
  }
  const ok = checks.every((c) => c.ok || !c.required);
  printJson({ ok, checks }, true);
  if (!ok) process.exitCode = 1;
}

/**
 * hwt shell-init zsh|bash|fish: a wrapper so `hwt rm` run from inside the removed checkout leaves you in
 * the main checkout instead of a deleted folder. eval "$(hwt shell-init zsh)" in your shell's rc file.
 */
export function cmdShellInit(args: string[]): void {
  const shell = args[0] ?? basename(process.env.SHELL ?? "zsh");
  const bin = selfCommand();
  const posix = `hwt() {
  local main
  main=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && main=\${main%/.git}
  command ${bin} "$@"
  local rc=$?
  [ -d "$PWD" ] || cd "\${main:-$HOME}"
  return $rc
}
`;
  const fish = `function hwt
  set -l main (git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | string replace -r '/\\.git$' '')
  command ${bin} $argv
  set -l rc $status
  test -d "$PWD"; or cd (test -n "$main"; and echo $main; or echo $HOME)
  return $rc
end
`;
  if (shell === "zsh" || shell === "bash" || shell === "sh") process.stdout.write(posix);
  else if (shell === "fish") process.stdout.write(fish);
  else die("usage: hwt shell-init zsh|bash|fish");
}

/**
 * hwt hook session-start: for an agent's session-start hook (Claude Code passes {cwd} on stdin). In a repo
 * whose main checkout has "mainSession": true, it tells the starting session its role and what the ledger
 * holds. Prints nothing anywhere else, and never fails the session start.
 */
export async function cmdHook(args: string[]): Promise<void> {
  if (args[0] !== "session-start") die("usage: hwt hook session-start");
  try {
    let cwd = process.cwd();
    if (!process.stdin.isTTY) {
      const input = await Bun.stdin.text();
      try {
        const c = JSON.parse(input)?.cwd;
        if (typeof c === "string" && existsSync(c)) cwd = c;
      } catch {}
    }
    process.chdir(cwd);
    const top = toplevel();
    if (!top) return;
    const main = repoMain();
    if (!isMainSessionRepo(main)) return;
    const m = messages(langFor(main));
    const self = selfCommand();
    if (samePath(top, main)) {
      let claimed = false;
      if (herdr.myTerminal()) {
        claimMain(main);
        claimed = true;
      }
      const l = readLedger(main);
      const brief = {
        notes: l.notes.map((n) => n.text),
        tasks: (l.tasks ?? [])
          .filter((t) => ["queued", "decided", "running"].includes(t.state))
          .map(({ id, title, state, decision, branch }) => ({ id, title, state, decision, branch })),
        merges: (l.merges ?? [])
          .filter((x) => !["done", "failed"].includes(x.state))
          .map(({ id, branch, pr, state }) => ({ id, branch, pr, state })),
        inbox_unacked: unackedInbox(main).map(({ id, text }) => ({ id, text: text.slice(0, 200) })),
        worktrees: Object.entries(l.worktrees)
          .filter(([, w]) => w.state === "active")
          .map(([b, w]) => ({ branch: b, title: w.title ?? null, session: w.session })),
      };
      process.stdout.write(`${m.sessionStartMain(basename(main), claimed)}\n${JSON.stringify(brief)}\n`);
    } else {
      process.stdout.write(m.sessionStartWorker(basename(main), basename(top), currentBranch(), self) + "\n");
    }
  } catch {
    // Never fail a session start.
  }
}

export { mainConfig, gitOut };
