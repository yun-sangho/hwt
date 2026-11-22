// Agent adapters. hwt starts any command as a working session; for agents it knows it also picks or finds
// the session id (so a lost session can be resumed) and adds the options they need in a worktree.
// Unknown commands still get started, tell and the inbox; only resume/fork need an adapter.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { basename, die } from "./util.ts";

export interface LaunchPlan {
  /** Program and arguments; the task is appended as the last argument (the agent's first prompt). */
  argv: string[];
  /** Session id known up front (Claude) or the one being resumed; null when only the agent knows it. */
  session: string | null;
}

export interface Adapter {
  kind: string;
  plan(words: string[], opts: { worktree: string; resume?: string; fork?: boolean }): LaunchPlan;
  /** The running agent's own session id, read inside it (for `hwt tell`). */
  sessionFromEnv(): string | undefined;
  /** Find the session of an agent started in <worktree> when its id couldn't be chosen up front. */
  findSession?(worktree: string): string | null;
}

const claude: Adapter = {
  kind: "claude",
  plan(words, { resume, fork }) {
    const argv = [...words];
    const has = (f: string) => argv.includes(f);
    if (resume) {
      const projects = join(homedir(), ".claude", "projects");
      const found =
        existsSync(projects) &&
        readdirSync(projects).some((d) => existsSync(join(projects, d, `${resume}.jsonl`)));
      if (!found) die(`no Claude session ${resume} under ~/.claude/projects`);
      if (fork) {
        const sid = crypto.randomUUID();
        argv.push("--resume", resume, "--fork-session", "--session-id", sid);
        return { argv, session: sid };
      }
      argv.push("--resume", resume);
      return { argv, session: resume };
    }
    if (has("--session-id") || has("--resume")) return { argv, session: null };
    const sid = crypto.randomUUID();
    argv.push("--session-id", sid);
    return { argv, session: sid };
  },
  sessionFromEnv: () => process.env.CLAUDE_CODE_SESSION_ID,
};

// Codex can't be given a session id: it is found after start (its rollout's cwd is the checkout), and each
// tell carries $CODEX_THREAD_ID. resume/fork are subcommands. --no-daemon keeps its commands in this
// terminal. Its workspace-write sandbox can't write a linked worktree's git metadata (it lives in the main
// .git/worktrees/), so a worktree agent runs with the sandbox off, like Claude Code.
const codex: Adapter = {
  kind: "codex",
  plan(words, { worktree, resume, fork }) {
    const [cmd, ...rest] = words as [string, ...string[]];
    const line = rest.join(" ");
    const flags = ["--no-daemon", "-C", worktree];
    if (!/(^|\s)(-s|--sandbox|--dangerously-bypass\S*)(\s|=|$)/.test(line)) flags.push("-s", "danger-full-access");
    if (!/(^|\s)(-a|--ask-for-approval)(\s|=|$)/.test(line)) flags.push("-a", "on-request");
    if (resume) {
      return fork
        ? { argv: [cmd, "fork", resume, ...flags, ...rest], session: null }
        : { argv: [cmd, "resume", resume, ...flags, ...rest], session: resume };
    }
    return { argv: [cmd, ...flags, ...rest], session: null };
  },
  sessionFromEnv: () => process.env.CODEX_THREAD_ID,
  findSession(worktree) {
    const root = join(homedir(), ".codex", "sessions");
    if (!existsSync(root)) return null;
    const weekAgo = Date.now() - 7 * 86400_000;
    const files: { f: string; t: number }[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^rollout-.*\.jsonl$/.test(e.name)) {
          const t = statSync(p).mtimeMs;
          if (t > weekAgo) files.push({ f: p, t });
        }
      }
    };
    walk(root);
    files.sort((a, b) => a.f < b.f ? 1 : -1);
    for (const { f } of files) {
      try {
        const first = JSON.parse(readFileSync(f, "utf8").split("\n", 1)[0] ?? "");
        if (first?.payload?.cwd === worktree) return first.payload.id ?? null;
      } catch {}
    }
    return null;
  },
};

const generic = (kind: string): Adapter => ({
  kind,
  plan(words, { resume }) {
    if (resume) die(`hwt can't resume a ${kind} session (no adapter for it)`);
    return { argv: [...words], session: null };
  },
  sessionFromEnv: () => undefined,
});

const known: Record<string, Adapter> = { claude, codex };

export function adapterFor(words: string[]): Adapter {
  const kind = basename(words[0] ?? "");
  return known[kind] ?? generic(kind);
}

/** The session id of whichever known agent this process runs inside, if any. */
export function sessionFromEnv(): string {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || "";
}

export { codex as codexAdapter };
