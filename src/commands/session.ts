// hwt claim / main / tell / inbox / ack / note / status / wait
import { codexAdapter, sessionFromEnv } from "../agents.ts";
import { currentBranch, repoMain, samePath, toplevel, worktreeList } from "../git.ts";
import * as herdr from "../herdr.ts";
import { ack, appendInbox, readInbox, readLedger, unackedInbox, updateLedger } from "../ledger.ts";
import { claimMain, mainLabel, mainOnly, resolveMain } from "../session.ts";
import { parse } from "../args.ts";
import { basename, die, has, inboxId, printJson, run, sleepMs, stamp } from "../util.ts";

export function cmdClaim(): void {
  const main = repoMain();
  if (!samePath(toplevel(), main)) die("claim runs in the main checkout");
  if (!herdr.myTerminal()) die("not in an hc terminal");
  claimMain(main);
  printJson({ main: herdr.myTerminal(), label: mainLabel(main) });
}

export function cmdMain(): void {
  process.stdout.write(resolveMain(repoMain()) + "\n");
}

/**
 * hwt tell TEXT: a working session's message to the main session. It always lands in the inbox first,
 * then goes to whichever terminal is the main session now. Never addresses a fixed id.
 */
export function tell(text: string): { id: string; main: string | null; delivered: boolean; inbox: true } {
  if (!text) die("usage: hwt tell <text>");
  const main = repoMain();
  const here = toplevel() ?? "";
  const me = herdr.myTerminal();
  const id = inboxId();
  let name = "";
  if (me) {
    const t = herdr.terminal(me);
    name = t?.name || t?.labels?.["hwt.worktree"] || "";
  }
  const branch = currentBranch();
  const session = sessionFromEnv();
  appendInbox(main, { id, at: stamp(), from: me, name, branch, path: here, session, text });
  // The sender's own session id fills a gap in the ledger (Codex's id is only known from inside).
  if (session) {
    updateLedger(main, (l) => {
      const w = l.worktrees[branch];
      if (w && !w.session) w.session = session;
    });
  }
  const to = resolveMain(main);
  const title = readLedger(main).worktrees[branch]?.title ?? "";
  let shown = text;
  if (here && !samePath(here, main)) shown += ` — ${basename(here)}${title ? `: ${title}` : ""}`;
  let delivered = false;
  if (to && to !== me) delivered = herdr.send(to, `${shown} (hwt inbox ${id})`);
  return { id, main: to || null, delivered, inbox: true };
}

export function cmdTell(args: string[]): void {
  printJson(tell(args.join(" ")));
}

/** hwt inbox [--all]: messages not yet acked (all with --all), one JSON object per line. */
export function cmdInbox(args: string[]): void {
  const main = repoMain();
  mainOnly(main, "inbox");
  const list = args[0] === "--all" ? readInbox(main) : unackedInbox(main);
  for (const m of list) process.stdout.write(JSON.stringify(m) + "\n");
}

export function cmdAck(args: string[]): void {
  const main = repoMain();
  mainOnly(main, "ack");
  if (args[0] === "--all") ack(main, unackedInbox(main).map((m) => m.id));
  else if (args.length) ack(main, args);
  else die("usage: hwt ack <id>...|--all");
}

const NOTE_USAGE = "hwt note [--branch B] <text> | note --drop <n>  (n: 1 = oldest note in hwt status)";

/** hwt note [--branch B] TEXT: a user decision or standing permission the main session must not lose. */
export function cmdNote(args: string[]): void {
  const a = parse(args, { opts: ["branch", "drop"] }, NOTE_USAGE);
  if (a.opt.drop !== undefined) {
    const main = repoMain();
    const n = Number(a.opt.drop);
    const notes = readLedger(main).notes;
    const want = notes[n - 1];
    if (!Number.isInteger(n) || !want) die(`no note ${a.opt.drop} (there are ${notes.length})`);
    // Drop by identity, not position, in case another note landed in between.
    updateLedger(main, (l) => {
      l.notes = l.notes.filter((x) => !(x.at === want.at && x.text === want.text));
    });
    return printJson({ dropped: want });
  }
  if (!a.pos.length) die(`usage: ${NOTE_USAGE}`);
  updateLedger(repoMain(), (l) => {
    l.notes.push({ at: stamp(), branch: a.opt.branch ?? null, text: a.pos.join(" ") });
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

/** hwt status [--prs]: everything a restarted main session needs, in one JSON object. */
export function cmdStatus(args: string[]): void {
  const main = repoMain();
  fillCodexSessions(main);
  const live = herdr.terminals();
  const wts = worktreeList(main);
  let prs: { number: number; headRefName: string; state: string }[] | null = null;
  if (args[0] === "--prs" && has("gh")) {
    const r = run(["gh", "pr", "list", "--state", "all", "--limit", "40", "--json", "number,headRefName,state"], { cwd: main });
    try {
      prs = r.ok ? JSON.parse(r.out) : null;
    } catch {}
  }
  const l = readLedger(main);
  const now = resolveMain(main);
  const under = (p: string | undefined, d: string) => !!p && (p === d || p.startsWith(d + "/"));
  printJson(
    {
      main: { recorded: l.main, live_now: now || null },
      notes: l.notes,
      tasks: (l.tasks ?? []).filter((t) => ["queued", "decided", "running"].includes(t.state)),
      merges: (l.merges ?? []).filter((m) => !["done", "failed"].includes(m.state)),
      inbox_unacked: unackedInbox(main),
      worktrees: wts
        .filter((w) => w.path !== main)
        .map((w) => {
          const r = l.worktrees[w.branch] ?? null;
          const name = basename(w.path);
          const pr = prs?.find((p) => p.headRefName === w.branch);
          return {
            worktree: name,
            title: r?.title ?? null,
            label: name + (r?.title ? ` (${r.title})` : ""),
            branch: w.branch,
            path: w.path,
            ledger: r
              ? { terminal: r.terminal, name: r.name, session: r.session, task: r.task, created: r.created, state: r.state }
              : null,
            terminals: live
              .filter((t) => under(t.cwd, w.path))
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
 * hwt wait [--timeout S]: block until the inbox has something unacked or a child has news.
 * A wake-up for a message is only a hint (hc replays messages absorbed mid-turn); the inbox decides.
 */
export function cmdWait(args: string[]): void {
  const timeout = args[0] === "--timeout" ? Number(args[1] ?? 1800) : 1800;
  const main = repoMain();
  mainOnly(main, "wait");
  const end = Date.now() + timeout * 1000;
  while (Date.now() < end) {
    const n = unackedInbox(main);
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
