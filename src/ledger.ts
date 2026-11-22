// Main-session state, kept in <git common dir>/hwt/, shared by every checkout and never committed:
//   ledger.json  {main, notes, worktrees, tasks, merges}   rewritten under a lock
//   inbox.jsonl  one line per `hwt tell` (worker → main), appended, never rewritten
//   acked        ids the main session has handled, one per line
// The format is the one the original zsh hwt wrote, so both can read the same ledger.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commonGitDir } from "./git.ts";
import { sleepMs, warn } from "./util.ts";

export interface MainRecord {
  terminal: string;
  session: string | null;
  claimed: string;
}

export interface Note {
  at: string;
  branch: string | null;
  text: string;
}

export interface WorktreeRecord {
  path: string;
  title?: string;
  agent?: string;
  terminal: string | null;
  name: string | null;
  session: string | null;
  task?: string;
  created: string;
  state: "active" | "removed";
  removed?: string;
}

export type TaskState = "queued" | "decided" | "running" | "done" | "dropped";

export interface Task {
  id: string;
  title: string;
  detail: string;
  touches: string[];
  from: string;
  added: string;
  state: TaskState;
  decision: string | null;
  why: string | null;
  branch: string | null;
  decided?: string;
  started?: string;
  closed?: string;
}

export type MergeState = "queued" | "waiting_user" | "merging" | "verifying" | "done" | "returned" | "failed";

export interface Merge {
  id: string;
  branch: string;
  pr: number | null;
  path: string;
  from: string;
  note: string;
  requested: string;
  state: MergeState;
  why: string | null;
  approved?: string;
  approved_why?: string;
  [stateStamp: string]: unknown;
}

export interface Ledger {
  main: MainRecord | null;
  notes: Note[];
  worktrees: Record<string, WorktreeRecord>;
  tasks?: Task[];
  merges?: Merge[];
}

export interface InboxMessage {
  id: string;
  at: string;
  from: string;
  name: string;
  branch: string;
  path: string;
  session: string;
  text: string;
}

const empty = (): Ledger => ({ main: null, notes: [], worktrees: {} });

export function stateDir(main: string): string {
  const d = join(commonGitDir(main), "hwt");
  mkdirSync(d, { recursive: true });
  return d;
}

export function readLedger(main: string): Ledger {
  const f = join(stateDir(main), "ledger.json");
  if (!existsSync(f)) return empty();
  try {
    return { ...empty(), ...(JSON.parse(readFileSync(f, "utf8")) as Ledger) };
  } catch {
    warn(`can't parse ${f}; reading it as empty`);
    return empty();
  }
}

/** Lock (mkdir, atomic on every filesystem), read, change, write a temp file, rename, unlock. */
export function updateLedger(main: string, change: (l: Ledger) => void): Ledger {
  const d = stateDir(main);
  const lock = join(d, "lock");
  let locked = false;
  for (let i = 0; i < 100 && !locked; i++) {
    try {
      mkdirSync(lock);
      locked = true;
    } catch {
      // A lock left by a crashed hwt: older than 30 s is stale.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
      } catch {}
      sleepMs(100);
    }
  }
  if (!locked) warn("ledger lock busy for 10 s; writing anyway");
  try {
    const l = readLedger(main);
    change(l);
    const f = join(d, "ledger.json");
    writeFileSync(f + ".tmp", JSON.stringify(l, null, 2) + "\n");
    renameSync(f + ".tmp", f);
    return l;
  } finally {
    if (locked) {
      try {
        rmdirSync(lock);
      } catch {}
    }
  }
}

export function appendInbox(main: string, m: InboxMessage): void {
  appendFileSync(join(stateDir(main), "inbox.jsonl"), JSON.stringify(m) + "\n");
}

export function readInbox(main: string): InboxMessage[] {
  const f = join(stateDir(main), "inbox.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as InboxMessage];
      } catch {
        return [];
      }
    });
}

function ackedIds(main: string): Set<string> {
  const f = join(stateDir(main), "acked");
  return new Set(existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
}

export function unackedInbox(main: string): InboxMessage[] {
  const acked = ackedIds(main);
  return readInbox(main).filter((m) => !acked.has(m.id));
}

export function ack(main: string, ids: string[]): void {
  if (ids.length) appendFileSync(join(stateDir(main), "acked"), ids.join("\n") + "\n");
}
