// Main sessions: who they are, which one owns what, and the guard that keeps new/rm in them.
//
// A repo can have several main sessions. By default a main works in the main checkout (the session-start hook
// claims every session there); a working session can also become a main of its own with `hwt claim` in its
// worktree. Each main owns the worktrees it makes, and those working sessions report to it alone.
import { basename } from "./util.ts";
import { mainConfig, langFor } from "./config.ts";
import { currentBranch, samePath, toplevel } from "./git.ts";
import { childKey, isGit, workDir } from "./project.ts";
import * as herdr from "./herdr.ts";
import { appendInbox, readLedger, updateLedger, type InboxMessage, type Ledger, type MainRecord } from "./ledger.ts";
import { sessionFromEnv } from "./agents.ts";
import { messages } from "./messages.ts";
import { die, inboxId, stamp } from "./util.ts";

export const mainLabel = (main: string) => `hwt.main=${basename(main)}`;

export function isMainSessionRepo(main: string): boolean {
  return mainConfig(main).mainSession === true;
}

/**
 * This process's main-session id: its agent session id (it survives a resume and a new terminal), else its hc
 * terminal. Empty outside any agent and terminal: such a caller sees every main's records.
 */
export function mainId(): string {
  return sessionFromEnv() || herdr.myTerminal() || "";
}

/**
 * The id this caller is known by in the ledger: mainId() if a main has it, else the main whose terminal this is
 * (a hook may have claimed with a session id the shell doesn't carry). Else mainId(), for records it makes.
 */
export function selfId(l: Ledger): string {
  const id = mainId();
  if (id && l.mains[id]) return id;
  const t = herdr.myTerminal();
  const byTerminal = t ? Object.entries(l.mains).find(([, r]) => r.terminal === t)?.[0] : undefined;
  return byTerminal ?? id;
}

/** A record with no owner belongs to every main; an empty id (no session at all) sees everything. */
export function owns(me: string, owner: string | null | undefined): boolean {
  return !me || !owner || owner === me;
}

/** The main that owns the worktree on <branch>, if any. */
/**
 * A working session that switched its worktree to another branch (git switch -c …-2): its record is still under
 * the old branch, so its owner, task and criteria aren't found and its messages go to every main. Move the record
 * (and the tasks and notes of that branch) to the branch it is on now. Returns the key it is under.
 */
export function followBranch(main: string): string {
  if (!isGit(main)) return "";
  const top = toplevel();
  if (!top || samePath(top, main)) return "";
  const b = currentBranch(top);
  if (!b || readLedger(main).worktrees[b]) return b;
  updateLedger(main, (l) => {
    if (l.worktrees[b]) return;
    const old = Object.entries(l.worktrees).find(([, w]) => w.state === "active" && w.kind !== "folder" && samePath(w.path, top))?.[0];
    if (!old) return;
    l.worktrees[b] = l.worktrees[old]!;
    delete l.worktrees[old];
    for (const t of l.tasks ?? []) if (t.branch === old && t.state !== "done" && t.state !== "dropped") t.branch = b;
    for (const n of l.notes) if (n.branch === old) n.branch = b;
  });
  return b;
}

export function ownerOf(l: Ledger, branch: string): string | null {
  return l.worktrees[branch]?.owner ?? null;
}

export function liveTerminal(r: MainRecord | undefined): string {
  if (!r?.terminal) return "";
  const t = herdr.terminal(r.terminal);
  return t && herdr.isLive(t) ? t.address : "";
}

/** The main this caller is, if it claimed one: its id is in the ledger and it works where it claimed. */
export function myMain(main: string, l = readLedger(main)): { id: string; record: MainRecord } | null {
  const id = selfId(l);
  const r = id ? l.mains[id] : undefined;
  return r && samePath(r.path, workDir(main, l)) ? { id, record: r } : null;
}

/**
 * Whether this caller acts as a main: a claimed main, or anyone who isn't a child session (in a git repo: anyone
 * in the main checkout; in a folder: anyone hwt didn't start as a child).
 */
export function actsAsMain(main: string, l = readLedger(main)): boolean {
  if (myMain(main, l)) return true;
  const k = childKey(main, l);
  if (isGit(main)) return !k && samePath(workDir(main, l), main);
  return !k;
}

export interface Claim {
  id: string;
  terminal: string | null;
  path: string;
  /** A worktree's session became a main: the main that owned the worktree before. */
  promoted_from: string | null;
  /** Mains that had this terminal before (a new agent session in it): their records came to this one. */
  took_over: string[];
}

/**
 * Register the caller as a main session: in the project root, or as child <child> (a worktree or folder child)
 * whose session becomes a main of its own (it then owns that child record, and its old main is told). Other
 * mains stay mains.
 * A main whose terminal this caller now has is gone (one agent per terminal): its worktrees, tasks and notes
 * come to this one, so a new session in the same terminal carries on the same work.
 */
export function claimMain(main: string, child: string | null, id = mainId()): Claim {
  if (!id) die("no agent session or hc terminal to name this main session by");
  const terminal = herdr.myTerminal() || null;
  if (terminal) herdr.label(terminal, mainLabel(main));
  const path = child ? (readLedger(main).worktrees[child]?.path ?? die(`no child ${child} in the ledger`)) : main;
  let promotedFrom: string | null = null;
  const branch = child ?? "";
  const tookOver: string[] = [];
  updateLedger(main, (l) => {
    l.mains ??= {};
    if (terminal) {
      for (const [old, r] of Object.entries(l.mains)) {
        if (old === id || r.terminal !== terminal) continue;
        tookOver.push(old);
        delete l.mains[old];
      }
    }
    const moved = (o: string | null | undefined) => !!o && tookOver.includes(o);
    for (const w of Object.values(l.worktrees)) if (moved(w.owner)) w.owner = id;
    for (const t of l.tasks ?? []) if (moved(t.owner)) t.owner = id;
    for (const n of l.notes) if (moved(n.owner)) n.owner = id;
    const w = child ? l.worktrees[child] : undefined;
    if (w) {
      if (w.owner !== id) promotedFrom = w.owner ?? null;
      w.owner = id;
      w.self_main = true;
    }
    l.mains[id] = { terminal, session: sessionFromEnv() || (id !== terminal ? id : null), path, claimed: stamp() };
  });
  if (promotedFrom && promotedFrom !== id) {
    const text = messages(langFor(main)).promoted(basename(path), branch);
    notifyMain(main, promotedFrom, { branch, path, text, wake: false });
  }
  return { id, terminal, path, promoted_from: promotedFrom, took_over: tookOver };
}

/**
 * Put a message in one main's inbox and in front of it (a turn in its conversation). One that needs its decision
 * (wake) waits for an ack; a log entry is marked as needing nothing, and only keeps the main's picture current.
 */
export function notifyMain(main: string, to: string, m: { branch: string; path: string; text: string; wake: boolean }): boolean {
  const id = inboxId();
  const me = herdr.myTerminal();
  appendInbox(main, { id, at: stamp(), from: me, name: "", branch: m.branch, path: m.path, session: sessionFromEnv(), to, wake: m.wake, text: m.text });
  // A log entry goes to the main's terminal too, marked as needing nothing: the main keeps knowing where every
  // PR is without anyone asking it.
  const t = liveTerminal(readLedger(main).mains[to]);
  const tail = m.wake ? `(hwt inbox ${id})` : messages(langFor(main)).fyi(id);
  return !!t && t !== me && herdr.send(t, `${m.text} ${tail}`);
}

/**
 * Live terminals a message from <branch> goes to: its owner's, or, for a worktree with no owner, every live
 * main in the main checkout (they all read unowned mail).
 */
export function recipients(main: string, branch: string, l = readLedger(main)): string[] {
  const owner = ownerOf(l, branch);
  if (owner) {
    const t = liveTerminal(l.mains[owner]);
    return t ? [t] : [];
  }
  return [
    ...new Set(
      Object.values(l.mains)
        .filter((r) => samePath(r.path, main))
        .map(liveTerminal)
        .filter(Boolean),
    ),
  ];
}

/** A note about a branch whose work is over (worktree removed, or merge done): left out of status by default. */
export function noteIsOver(l: Ledger, branch: string | null): boolean {
  const w = branch ? l.worktrees[branch] : undefined;
  return !!branch && w?.state !== "active" &&
    (w?.state === "removed" || (l.merges ?? []).some((x) => x.branch === branch && x.state === "done"));
}

/** Whether <me> reads message <m>: addressed to it, or from a worktree it owns (or nobody owns). */
export function readsMessage(l: Ledger, me: string, m: InboxMessage): boolean {
  if (!me) return true;
  if (m.to) return m.to === me;
  return owns(me, ownerOf(l, m.branch));
}

/**
 * With "mainSession": true in the main checkout's .hwt.json, refuse unless the caller acts as a main (in the
 * main checkout, or a claimed main in its worktree). Guards new, rm, adopt, hold, a main's own mailbox (inbox,
 * ack, wait) and its notes: a working session must not mark its main's mail handled, nor write the main's notes
 * (it reports a decision with hwt tell "[decision] …" and the main notes it).
 */
export function mainOnly(main: string, cmd: "new" | "rm" | "adopt" | "inbox" | "ack" | "wait" | "note" | "hold"): void {
  if (process.env.HWT_ANYWHERE) return;
  // A folder child is always a child, config or not: it shares the folder, so nothing else keeps it in its lane.
  if (!isMainSessionRepo(main) && !(process.env.HWT_CHILD && !isGit(main))) return;
  const l = readLedger(main);
  if (actsAsMain(main, l)) return;
  const owner = ownerOf(l, childKey(main, l));
  const now = owner ? liveTerminal(l.mains[owner]) : "";
  die(messages(langFor(main)).mainOnly(main, cmd, now));
}
