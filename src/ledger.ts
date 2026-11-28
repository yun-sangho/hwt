// Main-session state, kept in <git common dir>/hwt/ (a plain folder's: ~/.local/state/hwt/projects/…), shared by
// every checkout and never committed:
//   ledger.json  {mains, notes, worktrees, tasks, merges}   rewritten under a lock (the one before: ledger.json.bak)
//   inbox.jsonl  one line per `hwt tell` (worker → its main), appended, never rewritten
//   acked        ids a main session has handled, one per line
//   shown        ids hwt has put in front of a main (inbox, wait, status): ack --all acks only these
// A repo can have several main sessions. Each owns the worktrees it made (worktree.owner = its id), and the
// tasks, notes, inbox messages and merge requests that come with them. Records with no owner (made before
// there were owners, or by no session at all) belong to every main.
// The format is the one the original zsh hwt wrote, so both can read the same ledger.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isGit, stateDirFor } from "./project.ts";
import { rememberRepo } from "./repos.ts";
import { die, shQuote, sleepMs } from "./util.ts";

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
  /** What must hold in production once its PR is deployed (hwt new --verify); its merge request carries it. */
  verify?: string[];
  /** "folder": a child in a plain folder, no checkout of its own. Default: a git worktree. */
  kind?: "worktree" | "folder";
  /** The Herdr space hwt opened for it. */
  space?: string | null;
  created: string;
  /** Kept until the person releases it (hwt hold): rm and the merge queue's cleanup leave it. The reason. */
  hold?: string | null;
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
  /** What must hold in production once it ships (hwt new --task-id … --verify). */
  verify?: string[];
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
  | "checking" // deployed; the working session checks the live site (verify, post_deploy), then releases it
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
  /** What must hold in production after the deploy: the main's criteria (hwt new --verify), only it changes them. */
  verify?: string[];
  /** Risks of this implementation to check after the deploy: the working session's (hwt mq add --post-deploy). */
  post_deploy?: string[];
  /** checking: when it started; released (hwt mq release) with what the check found; overdue: the main was told. */
  checking_since?: string;
  released?: string;
  check_result?: string;
  check_overdue?: string;
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
  /**
   * false: a log entry (hwt inbox --log, hwt status). It is put in front of the main marked as needing nothing,
   * so the main knows where things stand; it doesn't end hwt wait and never needs an ack. Absent or true: it
   * needs the main's decision.
   */
  wake?: boolean;
  text: string;
}

const empty = (): Ledger => ({ mains: {}, notes: [], worktrees: {} });

/** <git common dir>/hwt in a repo; a folder under ~/.local/state/hwt for a plain folder (see project.ts). */
export function stateDir(main: string, create = true): string {
  return stateDirFor(main, create);
}

/**
 * The ledger as written, or an empty one when there is none yet. A ledger that is there but can't be read stops
 * the command: reading it as empty would let the next write replace every note, task and merge with nothing.
 */
export function readLedger(main: string): Ledger {
  const f = join(stateDir(main, false), "ledger.json");
  if (!existsSync(f)) return empty();
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    unreadable(f, (e as Error).message);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) unreadable(f, "not a JSON object");
  return { ...empty(), ...(v as Ledger) };
}

function unreadable(f: string, why: string): never {
  const bak = f + ".bak";
  die(
    `can't read ${f} (${why}); hwt leaves it as it is.\n` +
      (existsSync(bak) ? `  the copy from before the last write: cp ${shQuote(bak)} ${shQuote(f)}\n` : "") +
      "  or fix the JSON by hand",
  );
}

/** How long a write waits for the lock. A lock older than STALE_MS is a crashed hwt's and is taken over. */
const STALE_MS = 30_000;
const lockWaitMs = () => Number(process.env.HWT_LOCK_WAIT_MS) || STALE_MS + 5_000;

/**
 * Lock (mkdir, atomic on every filesystem), read, change, write a temp file, rename, unlock. The ledger it
 * replaces is kept as ledger.json.bak. No lock, no write: two writers would each drop the other's change.
 */
export function updateLedger(main: string, change: (l: Ledger) => void): Ledger {
  const d = stateDir(main);
  const lock = join(d, "lock");
  const until = Date.now() + lockWaitMs();
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(lock);
      locked = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmdirSync(lock);
      } catch {}
      if (Date.now() >= until) {
        die(`the ledger is locked (${lock}); another hwt is writing it. Try again, or remove that folder if no hwt is running`);
      }
      sleepMs(100);
    }
  }
  try {
    const l = readLedger(main);
    change(l);
    const f = join(d, "ledger.json");
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2) + "\n");
    if (existsSync(f)) copyFileSync(f, f + ".bak");
    renameSync(tmp, f);
    // The merge-queue daemon looks at every git repo whose ledger hwt writes.
    if (isGit(main)) rememberRepo(main);
    return l;
  } finally {
    try {
      rmdirSync(lock);
    } catch {}
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

/** Messages that need the main and that it hasn't handled yet (log entries never need handling). */
export function unackedInbox(main: string): InboxMessage[] {
  const acked = ackedIds(main);
  return readInbox(main).filter((m) => m.wake !== false && !acked.has(m.id));
}

/** Log entries: what happened that the main may look at, but needn't act on. */
export function logInbox(main: string): InboxMessage[] {
  return readInbox(main).filter((m) => m.wake === false);
}

export function ack(main: string, ids: string[]): void {
  if (ids.length) appendFileSync(join(stateDir(main), "acked"), ids.join("\n") + "\n");
}

/** Record that these messages were put in front of a main (so ack --all may take them). */
export function markShown(main: string, ids: string[]): void {
  if (ids.length) appendFileSync(join(stateDir(main), "shown"), ids.join("\n") + "\n");
}

export function shownIds(main: string): Set<string> {
  const f = join(stateDir(main, false), "shown");
  return new Set(existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
}
