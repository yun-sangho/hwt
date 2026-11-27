// hwt init / doctor / shell-init / hook session-start
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../args.ts";
import { langFor, mainConfig, userConfigPath, worktreesRoot, type RepoConfig } from "../config.ts";
import { currentBranch, gitOut, realpath, samePath, toplevel } from "../git.ts";
import { childKey, isGit, projectRoot } from "../project.ts";
import * as herdr from "../herdr.ts";
import { readLedger, stateDir, unackedInbox } from "../ledger.ts";
import { messages, selfCommand } from "../messages.ts";
import { claimMain, isMainSessionRepo, mainId, noteIsOver, owns } from "../session.ts";
import { basename, die, has, printJson, run, runOut, warn } from "../util.ts";
import { liveDaemon, serviceInstalled } from "../daemon.ts";
import { claudeDir, claudeHookInstalled, codexBlockInstalled, codexDir, ourSkill } from "./install.ts";

const INIT_USAGE = "hwt init [--main-session] [--setup CMD] [--lang en|ko] [--force]";

/**
 * Lockfiles in the repo root, one group per ecosystem, first match wins inside a group. A group counts only
 * when its manifest is there too: a stray package-lock.json in a Go repo is not a JS project.
 */
const SETUP_GROUPS: { manifest?: string; pick: [string, string][] }[] = [
  {
    manifest: "package.json",
    pick: [
      ["pnpm-lock.yaml", "pnpm install"],
      ["bun.lock", "bun install"],
      ["bun.lockb", "bun install"],
      ["yarn.lock", "yarn install"],
      ["package-lock.json", "npm ci"],
    ],
  },
  { pick: [["uv.lock", "uv sync"], ["poetry.lock", "poetry install"]] },
  { pick: [["Gemfile.lock", "bundle install"]] },
  { pick: [["go.sum", "go mod download"]] },
];

/** A setup command guessed from the lockfiles in the repo root: every ecosystem's, joined with &&. */
function guessSetup(dir: string): { setup: string; from: string[] } | undefined {
  const found = SETUP_GROUPS.filter((g) => !g.manifest || existsSync(join(dir, g.manifest)))
    .map((g) => g.pick.find(([f]) => existsSync(join(dir, f))))
    .filter((p): p is [string, string] => !!p);
  if (!found.length) return undefined;
  return { setup: found.map(([, c]) => c).join(" && "), from: found.map(([f]) => f) };
}

export function cmdInit(args: string[]): void {
  const a = parse(args, { opts: ["setup", "lang"], flags: ["main-session", "force"] }, INIT_USAGE);
  // A plain folder works too: its .hwt.json makes it the project for everything below it.
  const main = isGit(process.cwd()) ? projectRoot() : realpath(process.cwd());
  if (isGit(main) && !samePath(toplevel(), main)) die("run hwt init in the main checkout");
  const f = join(main, ".hwt.json");
  if (existsSync(f) && !a.flag.force) die(`${f} exists (pass --force to rewrite it)`);
  const cfg: RepoConfig = { version: 1 };
  const guess = a.opt.setup === undefined ? guessSetup(main) : undefined;
  const setup = a.opt.setup ?? guess?.setup;
  if (setup) cfg.setup = setup;
  if (guess) warn(`setup: ${guess.setup} (from ${guess.from.join(", ")}); change it in .hwt.json if that's wrong`);
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
  {
    const skill = join(claudeDir(), "skills", "hwt", "SKILL.md");
    const ok = ourSkill(skill) && claudeHookInstalled();
    add("claude integration", ok, false, ok
      ? `skill and SessionStart hook in ${claudeDir()}`
      : `${ourSkill(skill) ? "" : "no hwt skill; "}${claudeHookInstalled() ? "" : "no SessionStart hook; "}run: hwt install claude`);
  }
  if (has("codex") || existsSync(codexDir())) {
    const ok = ourSkill(join(codexDir(), "skills", "hwt", "SKILL.md")) && codexBlockInstalled();
    add("codex integration", ok, false, ok ? `skill and AGENTS.md block in ${codexDir()}` : "run: hwt install codex");
  }
  {
    const d = liveDaemon();
    const svc = process.platform === "darwin" && serviceInstalled();
    add("merge-queue daemon", true, false, d
      ? `running (pid ${d.pid}${svc ? ", launchd" : ""})`
      : svc ? "installed in launchd but not running: see hwt mq daemon status" : "off: a main runs hwt mq run, or start one with hwt mq daemon install");
  }
  add("user config", true, false, existsSync(userConfigPath()) ? userConfigPath() : `${userConfigPath()} (none, defaults)`);

  {
    const main = projectRoot();
    const f = join(main, ".hwt.json");
    let detail = "none (defaults; hwt init writes one)";
    let ok = true;
    if (existsSync(f)) {
      try {
        const c = JSON.parse(readFileSync(f, "utf8")) as RepoConfig & { teardown?: string };
        detail = `${f}: ${c.mainSession ? "main-session workflow" : "worktrees only"}${c.setup ? `, setup: ${c.setup}` : ""}${isGit(main) ? "" : " (plain folder: children share it)"}`;
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
      add("ledger", true, false, `${stateDir(main, false)}: ${Object.keys(l.worktrees).length} worktrees, ${(l.tasks ?? []).length} tasks, ${unackedInbox(main).length} unread`);
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
 * hwt hook session-start: for an agent's session-start hook (Claude Code passes {cwd, session_id} on stdin). In
 * a repo whose main checkout has "mainSession": true, it tells the starting session its role and what of the
 * ledger is its own; a session in the main checkout (or in a worktree it claimed) is claimed as a main.
 * Prints nothing anywhere else, and never fails the session start.
 */
export async function cmdHook(args: string[]): Promise<void> {
  if (args[0] !== "session-start") die("usage: hwt hook session-start");
  try {
    let cwd = process.cwd();
    let session = "";
    if (!process.stdin.isTTY) {
      const input = await Bun.stdin.text();
      try {
        const v = JSON.parse(input);
        if (typeof v?.cwd === "string" && existsSync(v.cwd)) cwd = v.cwd;
        if (typeof v?.session_id === "string") session = v.session_id;
      } catch {}
    }
    process.chdir(cwd);
    const main = projectRoot();
    const git = isGit(main);
    if (git && !toplevel()) return;
    // A plain folder takes part only when configured, or when this session is a child hwt started there
    // (so a session in any other folder doesn't leave a ledger behind).
    if (!isMainSessionRepo(main) && (git || !process.env.HWT_CHILD)) return;
    const m = messages(langFor(main));
    const self = selfCommand();
    const id = session || mainId();
    const l0 = readLedger(main);
    const key = childKey(main, l0);
    // A child whose session became a main (hwt claim there) starts as a main again when resumed.
    const promoted = !!key && !!l0.worktrees[key]?.self_main && (!id || !!l0.mains[id]);
    if (!key || promoted) {
      // Every session that isn't a child is a main; there can be several, each with its own children.
      const claimed = !!id;
      if (claimed) claimMain(main, promoted ? key : null, id);
      const l = readLedger(main);
      const mine = (o: string | null | undefined) => owns(id, o);
      const others = Object.keys(l.mains).filter((x) => x !== id).length;
      const brief = {
        me: id || null,
        other_mains: others,
        notes: l.notes.filter((n) => mine(n.owner) && !noteIsOver(l, n.branch)).map((n) => n.text),
        tasks: (l.tasks ?? [])
          .filter((t) => ["queued", "decided", "running"].includes(t.state) && mine(t.owner))
          .map(({ id, title, state, decision, branch }) => ({ id, title, state, decision, branch })),
        merges: (l.merges ?? [])
          .filter((x) => !["done", "failed", "dropped"].includes(x.state) && mine(l.worktrees[x.branch]?.owner))
          .map(({ id, branch, pr, state }) => ({ id, branch, pr, state })),
        inbox_unacked: unackedInbox(main)
          .filter((x) => (x.to ? x.to === id || !id : mine(l.worktrees[x.branch]?.owner)))
          .map(({ id, text }) => ({ id, text: text.slice(0, 200) })),
        worktrees: Object.entries(l.worktrees)
          .filter(([b, w]) => w.state === "active" && mine(w.owner) && b !== key)
          .map(([b, w]) => ({ branch: b, title: w.title ?? null, session: w.session })),
      };
      const where = promoted ? ` (${git ? "worktree" : "child"} ${git ? basename(l.worktrees[key]!.path) : key})` : "";
      process.stdout.write(`${m.sessionStartMain(basename(main) + where, claimed)}\n${JSON.stringify(brief)}\n`);
    } else if (git) {
      process.stdout.write(m.sessionStartWorker(basename(main), basename(toplevel()!), currentBranch(), self) + "\n");
    } else {
      const w = l0.worktrees[key]!;
      process.stdout.write(`${m.sessionStartWorker(basename(main), key, "-", self)}\n${m.folderChild(key, w.path)}\n`);
    }
  } catch {
    // Never fail a session start.
  }
}

export { mainConfig, gitOut };
