// hwt claim / adopt / main / tell / inbox / ack / note / status / wait
import { codexAdapter, sessionFromEnv } from "../agents.ts";
import { samePath, worktreeList } from "../git.ts";
import { childKey, findChild, isGit, projectRoot, workDir } from "../project.ts";
import * as herdr from "../herdr.ts";
import { ack, appendInbox, readInbox, readLedger, unackedInbox, updateLedger } from "../ledger.ts";
import {
  actsAsMain, claimMain, liveTerminal, mainOnly, myMain, ownerOf, owns, readsMessage, recipients, selfId,
} from "../session.ts";
import type { InboxMessage, Ledger } from "../ledger.ts";
import { parse } from "../args.ts";
import { basename, die, has, inboxId, printJson, run, sleepMs, stamp } from "../util.ts";

/**
 * hwt claim: this session is a main session. In the main checkout that is the default (the session-start hook
 * does it). In a worktree, its working session becomes a main of its own: it owns the worktree from then on and
 * may hand work to working sessions of its own.
 */
export function cmdClaim(): void {
  const main = projectRoot();
  const l = readLedger(main);
  const k = childKey(main, l);
  if (isGit(main) && !k && !samePath(workDir(main, l), main)) die("claim runs in the main checkout or a worktree hwt made");
  printJson(claimMain(main, k || null));
}

/** hwt adopt <worktree|branch>...: this main takes over worktrees whose main is gone (or another main's). */
export function cmdAdopt(args: string[]): void {
  if (!args.length) die("usage: hwt adopt <worktree|branch>...");
  const main = projectRoot();
  mainOnly(main, "adopt");
  const l0 = readLedger(main);
  const me = selfId(l0);
  if (!me) die("no agent session or hc terminal to own the worktrees by");
  if (!l0.mains[me]) claimMain(main, childKey(main, l0) || null, me);
  const adopted: { branch: string; from: string | null }[] = [];
  updateLedger(main, (l) => {
    for (const a of args) {
      const e = findChild(l, a);
      if (!e) die(`no worktree ${a} in the ledger`);
      const [b, w] = e;
      if (w.state !== "active") die(`${a} was removed`);
      if (w.self_main) die(`${a} is a main session of its own`);
      adopted.push({ branch: b, from: w.owner ?? null });
      w.owner = me;
      for (const t of l.tasks ?? []) if (t.branch === b) t.owner = me;
    }
  });
  printJson({ owner: me, adopted });
}

/** hwt main: the live terminal of the main this checkout reports to (a main: its own). */
export function cmdMain(): void {
  const main = projectRoot();
  const l = readLedger(main);
  const mine = myMain(main, l);
  const owner = mine ? mine.id : ownerOf(l, childKey(main, l));
  process.stdout.write((owner ? liveTerminal(l.mains[owner]) : "") + "\n");
}

/**
 * hwt tell TEXT: a working session's message to its main session (the worktree's owner). It always lands in
 * the inbox first, then goes to whichever terminal that main has now. Never addresses a fixed id.
 */
export function tell(text: string): { id: string; main: string | null; owner: string | null; delivered: boolean; inbox: true } {
  if (!text) die("usage: hwt tell <text>");
  const main = projectRoot();
  const l0 = readLedger(main);
  const here = workDir(main, l0);
  const branch = childKey(main, l0);
  const me = herdr.myTerminal();
  const id = inboxId();
  let name = "";
  if (me) {
    const t = herdr.terminal(me);
    name = t?.name || t?.labels?.["hwt.worktree"] || "";
  }
  const session = sessionFromEnv();
  appendInbox(main, { id, at: stamp(), from: me, name, branch, path: here, session, text });
  // The sender's own session id fills a gap in the ledger (Codex's id is only known from inside).
  if (session) {
    updateLedger(main, (l) => {
      const w = l.worktrees[branch];
      if (w && !w.session) w.session = session;
    });
  }
  const l = readLedger(main);
  const to = recipients(main, branch, l).filter((t) => t !== me);
  const w = l.worktrees[branch];
  const title = w?.title ?? "";
  const who = w ? (w.kind === "folder" ? branch : basename(w.path)) : samePath(here, main) ? "" : basename(here);
  let shown = text;
  if (who) shown += ` — ${who}${title ? `: ${title}` : ""}`;
  let delivered = false;
  for (const t of to) if (herdr.send(t, `${shown} (hwt inbox ${id})`)) delivered = true;
  return { id, main: to[0] ?? null, owner: ownerOf(l, branch), delivered, inbox: true };
}

export function cmdTell(args: string[]): void {
  printJson(tell(args.join(" ")));
}

/** This main's messages: addressed to it, from worktrees it owns, or from worktrees nobody owns. */
function myMessages(main: string, list: InboxMessage[], l: Ledger = readLedger(main)): InboxMessage[] {
  const me = selfId(l);
  return list.filter((m) => readsMessage(l, me, m));
}

/** hwt inbox [--all]: this main's messages not yet acked (all with --all), one JSON object per line. */
export function cmdInbox(args: string[]): void {
  const main = projectRoot();
  mainOnly(main, "inbox");
  const list = myMessages(main, args[0] === "--all" ? readInbox(main) : unackedInbox(main));
  for (const m of list) process.stdout.write(JSON.stringify(m) + "\n");
}

export function cmdAck(args: string[]): void {
  const main = projectRoot();
  mainOnly(main, "ack");
  if (args[0] === "--all") ack(main, myMessages(main, unackedInbox(main)).map((m) => m.id));
  else if (args.length) ack(main, args);
  else die("usage: hwt ack <id>...|--all");
}

const NOTE_USAGE = "hwt note [--branch B] <text> | note --drop <n>  (n: 1 = oldest note in hwt status)";

/** The notes this main keeps: its own and the ones nobody owns, oldest first (what hwt status shows). */
function myNotes(l: Ledger) {
  const me = selfId(l);
  return l.notes.filter((n) => owns(me, n.owner));
}

/** hwt note [--branch B] TEXT: a user decision or standing permission this main session must not lose. */
export function cmdNote(args: string[]): void {
  const a = parse(args, { opts: ["branch", "drop"] }, NOTE_USAGE);
  if (a.opt.drop !== undefined) {
    const main = projectRoot();
    const n = Number(a.opt.drop);
    const notes = myNotes(readLedger(main));
    const want = notes[n - 1];
    if (!Number.isInteger(n) || !want) die(`no note ${a.opt.drop} (there are ${notes.length})`);
    // Drop by identity, not position, in case another note landed in between.
    updateLedger(main, (l) => {
      l.notes = l.notes.filter((x) => !(x.at === want.at && x.text === want.text));
    });
    return printJson({ dropped: want });
  }
  if (!a.pos.length) die(`usage: ${NOTE_USAGE}`);
  const main = projectRoot();
  const asMain = actsAsMain(main);
  updateLedger(main, (l) => {
    // A working session's note belongs to its main.
    const owner = asMain ? selfId(l) : ownerOf(l, childKey(main, l));
    l.notes.push({ at: stamp(), owner: owner || null, branch: a.opt.branch ?? null, text: a.pos.join(" ") });
  });
}

/** Codex sessions can't be named up front: find the ones the ledger is missing from Codex's own records. */
function fillCodexSessions(main: string): void {
  const missing = Object.entries(readLedger(main).worktrees).filter(
    ([, w]) => w.state === "active" && w.agent === "codex" && !w.session,
  );
  for (const [b, w] of missing) {
    const id = codexAdapter.findSession?.(w.path);
    if (id) {
      updateLedger(main, (l) => {
        const r = l.worktrees[b];
        if (r) r.session = id;
      });
    }
  }
}

/**
 * hwt status [--prs]: everything a restarted main session needs, in one JSON object. Every main and every
 * worktree is listed (with its owner, and mine: true for this main's); notes, tasks and the inbox are this main's.
 */
export function cmdStatus(args: string[]): void {
  const main = projectRoot();
  fillCodexSessions(main);
  const live = herdr.terminals();
  const git = isGit(main);
  // Git: the checkouts git knows. Folder: the children the ledger has (they share folders, so git can't list them).
  const wts = git
    ? worktreeList(main)
    : Object.entries(readLedger(main).worktrees).filter(([, w]) => w.state === "active").map(([b, w]) => ({ branch: b, path: w.path }));
  let prs: { number: number; headRefName: string; state: string }[] | null = null;
  if (args[0] === "--prs" && git && has("gh")) {
    const r = run(["gh", "pr", "list", "--state", "all", "--limit", "40", "--json", "number,headRefName,state"], { cwd: main });
    try {
      prs = r.ok ? JSON.parse(r.out) : null;
    } catch {}
  }
  const l = readLedger(main);
  const me = selfId(l);
  const mine = (owner: string | null | undefined) => owns(me, owner);
  const under = (p: string | undefined, d: string) => !!p && (p === d || p.startsWith(d + "/"));
  printJson(
    {
      me: me || null,
      mains: Object.entries(l.mains).map(([id, r]) => ({
        id, terminal: r.terminal, session: r.session, path: r.path, claimed: r.claimed,
        live: !!liveTerminal(r), me: id === me,
      })),
      notes: myNotes(l),
      tasks: (l.tasks ?? []).filter((t) => ["queued", "decided", "running"].includes(t.state) && mine(t.owner)),
      // One queue for the repo (merges go one at a time), each item marked with the main that handles it.
      merges: (l.merges ?? [])
        .filter((m) => !["done", "failed"].includes(m.state))
        .map((m) => ({ ...m, owner: ownerOf(l, m.branch), mine: mine(ownerOf(l, m.branch)) })),
      inbox_unacked: myMessages(main, unackedInbox(main), l),
      worktrees: wts
        .filter((w) => !git || w.path !== main)
        .map((w) => {
          const r = l.worktrees[w.branch] ?? null;
          const name = git ? basename(w.path) : w.branch;
          const pr = prs?.find((p) => p.headRefName === w.branch);
          const owner = r?.owner ?? null;
          return {
            worktree: name,
            title: r?.title ?? null,
            label: name + (r?.title ? ` (${r.title})` : ""),
            branch: w.branch,
            kind: r?.kind ?? (git ? "worktree" : "folder"),
            path: w.path,
            owner,
            mine: !!r && mine(owner),
            main_of_its_own: !!r?.self_main,
            ledger: r
              ? { terminal: r.terminal, name: r.name, session: r.session, task: r.task, created: r.created, state: r.state }
              : null,
            // A folder child shares its folder: only its own terminal is its.
            terminals: live
              .filter((t) => (git ? under(t.cwd, w.path) : t.address === r?.terminal))
              .map((t) => ({ address: t.address, agent: t.agent ?? null, status: herdr.statusWord(t) })),
            pr: prs ? (pr ? { number: pr.number, state: pr.state } : null) : null,
          };
        }),
      ledger_only: Object.entries(l.worktrees)
        .filter(([b, w]) => w.state === "active" && !wts.some((x) => x.branch === b))
        .map(([b]) => b),
    },
    true,
  );
}

/**
 * hwt wait [--timeout S]: block until this main's inbox has something unacked or a child has news.
 * A wake-up for a message is only a hint (hc replays messages absorbed mid-turn); the inbox decides.
 */
export function cmdWait(args: string[]): void {
  const timeout = args[0] === "--timeout" ? Number(args[1] ?? 1800) : 1800;
  const main = projectRoot();
  mainOnly(main, "wait");
  const end = Date.now() + timeout * 1000;
  while (Date.now() < end) {
    const n = myMessages(main, unackedInbox(main));
    if (n.length) return printJson({ reason: "inbox", messages: n });
    const left = Math.ceil((end - Date.now()) / 1000);
    const r = herdr.waitChildren(left < 60 ? left + 1 : 60);
    const reason = r?.reason;
    if (reason === "message" || reason === "timeout") continue;
    if (reason === "children") {
      if (Array.isArray(r?.children) && r.children.length === 0) {
        sleepMs(5000);
        continue;
      }
      return printJson(r);
    }
    if (!r) {
      sleepMs(5000);
      continue;
    }
    return printJson(r);
  }
  printJson({ reason: "timeout" });
}

const MAINS_USAGE = "hwt mains [ls] | mains prune [--release] [--dry-run]";

/**
 * hwt mains [ls]: every main session in the ledger, live or not, with what it owns.
 * hwt mains prune: forget mains whose terminal is gone (never this one). A gone main that still owns active
 * worktrees is kept, since they would have no one to report to; --release forgets it anyway and leaves its
 * worktrees, tasks and notes unowned (every main sees them; one takes them with hwt adopt).
 */
export function cmdMains(args: string[]): void {
  const [sub = "ls", ...rest] = args[0]?.startsWith("-") ? ["ls", ...args] : args;
  if (sub === "--help" || sub === "-h" || rest.includes("--help") || rest.includes("-h")) {
    return void process.stdout.write(`usage: ${MAINS_USAGE}\n`);
  }
  const main = projectRoot();
  const l = readLedger(main);
  const me = selfId(l);
  const rows = Object.entries(l.mains).map(([id, r]) => {
    const owned = Object.entries(l.worktrees).filter(([, w]) => w.state === "active" && w.owner === id).map(([b]) => b);
    return { id, terminal: r.terminal, path: r.path, claimed: r.claimed, live: !!liveTerminal(r), me: id === me, owns: owned };
  });
  if (sub === "ls") return printJson(rows, true);
  if (sub !== "prune") die(`usage: ${MAINS_USAGE}`);
  const a = parse(rest, { flags: ["release", "dry-run"] }, MAINS_USAGE);
  const gone = rows.filter((r) => !r.live && !r.me);
  const drop = gone.filter((r) => a.flag.release || r.owns.length === 0);
  const kept = gone.filter((r) => !drop.includes(r)).map((r) => ({ id: r.id, owns: r.owns }));
  const released = drop.flatMap((r) => r.owns);
  if (!a.flag["dry-run"] && drop.length) {
    const ids = new Set(drop.map((r) => r.id));
    updateLedger(main, (x) => {
      for (const id of ids) delete x.mains[id];
      for (const w of Object.values(x.worktrees)) {
        if (w.owner && ids.has(w.owner)) {
          w.owner = null;
          w.self_main = false;
        }
      }
      for (const t of x.tasks ?? []) if (t.owner && ids.has(t.owner)) t.owner = null;
      for (const n of x.notes) if (n.owner && ids.has(n.owner)) n.owner = null;
    });
  }
  printJson(
    { pruned: drop.map((r) => r.id), released, kept_owning_worktrees: kept, dry_run: !!a.flag["dry-run"] },
    true,
  );
}
