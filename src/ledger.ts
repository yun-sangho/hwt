// Main-session state, kept in <git common dir>/hwt/ (a plain folder's: ~/.local/state/hwt/projects/…), shared by
// every checkout and never committed:
//   ledger.json  {mains, notes, worktrees, tasks, merges}   rewritten under a lock
//   inbox.jsonl  one line per `hwt tell` (worker → its main), appended, never rewritten
//   acked        ids a main session has handled, one per line
// A repo can have several main sessions. Each owns the worktrees it made (worktree.owner = its id), and the
// tasks, notes, inbox messages and merge requests that come with them. Records with no owner (made before
// there were owners, or by no session at all) belong to every main.
// The format is the one the original zsh hwt wrote, so both can read the same ledger.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDirFor } from "./project.ts";
import { sleepMs, warn } from "./util.ts";

/** A main session. Its id is its agent session id, else its hc terminal (see mainId). */
export interface MainRecord {
  terminal: string | null;
  session: string | null;
  /** Where it works: the main checkout, or a worktree whose working session became a main (hwt claim there). */
  path: string;
  claimed: string;
}

export interface Note {
  at: string;
  owner?: string | null;
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
  /** The main session this worktree reports to. A promoted worktree owns itself. */
  owner?: string | null;
  /** Its session became a main of its own (hwt claim there). */
  self_main?: boolean;
  /** "folder": a child in a plain folder, no checkout of its own. Default: a git worktree. */
  kind?: "worktree" | "folder";
  /** The Herdr space hwt opened for it. */
  space?: string | null;
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
  owner?: string | null;
  added: string;
  state: TaskState;
  decision: string | null;
  why: string | null;
  branch: string | null;
  decided?: string;
  started?: string;
  closed?: string;
}

/** Merge request states. The allowed moves between them are in mq.ts (MOVES). */
export type MergeState =
  | "queued" // waiting its turn
  | "updating" // the runner brought the PR up to date with its base; waiting for CI again
  | "waiting_user" // needs the person's yes (hwt mq approve)
  | "merging"
  | "verifying" // merged; the repo's deploy check runs
  | "cleaning" // verified; worktree, agent and branches go
  | "done"
  | "returned" // back to the working session to fix; it mq adds again
  | "failed" // the deploy check failed after the merge
  | "dropped";

export interface MergeEvent {
  at: string;
  from: MergeState | null;
  to: MergeState;
  by: string;
  why: string | null;
}

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
  /** Place in line: enqueue order, kept when the same branch is queued again after a return. */
  seq?: number;
  /** Higher goes first. Default 0. */
  priority?: number;
  /** Branches whose merges must be done first. */
  after?: string[];
  /** Times the runner brought the PR up to date with its base. */
  updates?: number;
  /** The merge commit, once merged. */
  sha?: string;
  history?: MergeEvent[];
  approved?: string;
  approved_why?: string;
  [stateStamp: string]: unknown;
}

/** One runner at a time drains the queue, whichever main started it. */
export interface MqLease {
  holder: string;
  pid: number;
  host: string;
  since: string;
  /** Epoch ms of its last sign of life. */
  beat: number;
}

export interface Ledger {
  mains: Record<string, MainRecord>;
  /** The single main of ledgers written before there could be several; read for nothing now. */
  main?: unknown;
  notes: Note[];
  worktrees: Record<string, WorktreeRecord>;
  tasks?: Task[];
  merges?: Merge[];
  mq?: { seq: number; lease: MqLease | null };
}

export interface InboxMessage {
  id: string;
  at: string;
  from: string;
  name: string;
  branch: string;
  path: string;
  session: string;
  /** For one main only (otherwise the sender's worktree owner decides who reads it). */
  to?: string;
  text: string;
}

const empty = (): Ledger => ({ mains: {}, notes: [], worktrees: {} });

/** <git common dir>/hwt in a repo; a folder under ~/.local/state/hwt for a plain folder (see project.ts). */
export function stateDir(main: string, create = true): string {
  return stateDirFor(main, create);
}

export function readLedger(main: string): Ledger {
  const f = join(stateDir(main, false), "ledger.json");
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
  const f = join(stateDir(main, false), "inbox.jsonl");
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
  const f = join(stateDir(main, false), "acked");
  return new Set(existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
}

export function unackedInbox(main: string): InboxMessage[] {
  const acked = ackedIds(main);
  return readInbox(main).filter((m) => !acked.has(m.id));
}

export function ack(main: string, ids: string[]): void {
  if (ids.length) appendFileSync(join(stateDir(main), "acked"), ids.join("\n") + "\n");
}
