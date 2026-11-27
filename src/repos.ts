// Machine-wide hwt state: ~/.local/state/hwt (XDG_STATE_HOME). repos.json lists the main checkouts of the git
// repos whose ledger hwt has written, for the merge-queue daemon (daemon.ts).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const stateHome = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "hwt");
const reposFile = () => join(stateHome(), "repos.json");

export function readJson<T>(f: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(f: string, v: unknown): void {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  renameSync(tmp, f);
}

// ---- Repos --------------------------------------------------------------------------------

export function knownRepos(): string[] {
  const r = readJson<unknown>(reposFile(), []);
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

/** Remember a git repo's main checkout for the daemon. Cheap when it is already known; never fails a command. */
export function rememberRepo(main: string): void {
  try {
    const repos = knownRepos();
    if (repos.includes(main)) return;
    writeJson(reposFile(), [...repos, main]);
  } catch {}
}

export function forgetRepos(gone: string[]): void {
  if (!gone.length) return;
  try {
    writeJson(reposFile(), knownRepos().filter((r) => !gone.includes(r)));
  } catch {}
}

