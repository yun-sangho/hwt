// Who the main session is, and the guard that keeps new/rm in it.
import { basename } from "./util.ts";
import { mainConfig, langFor } from "./config.ts";
import { samePath, toplevel } from "./git.ts";
import * as herdr from "./herdr.ts";
import { updateLedger } from "./ledger.ts";
import { sessionFromEnv } from "./agents.ts";
import { messages } from "./messages.ts";
import { die, stamp } from "./util.ts";

export const mainLabel = (main: string) => `hwt.main=${basename(main)}`;

export function isMainSessionRepo(main: string): boolean {
  return mainConfig(main).mainSession === true;
}

/** Mark this terminal as the repo's main session: label hwt.main=<repo> and record it in the ledger. */
export function claimMain(main: string): void {
  const me = herdr.myTerminal();
  if (!me) return;
  herdr.label(me, mainLabel(main));
  updateLedger(main, (l) => {
    l.main = { terminal: me, session: sessionFromEnv() || null, claimed: stamp() };
  });
}

/**
 * Address of the live main session: the newest live terminal labelled hwt.main=<repo>, else the one live
 * agent terminal sitting in the main checkout. Empty when none (the main session is down).
 */
export function resolveMain(main: string): string {
  let live = herdr.terminals(mainLabel(main)).filter(herdr.isLive);
  if (live.length > 1) {
    const withTime = live.map((t) => ({ t, ms: t.created_ms ?? herdr.terminal(t.address)?.created_ms ?? 0 }));
    withTime.sort((a, b) => a.ms - b.ms);
    live = [withTime[withTime.length - 1]!.t];
  }
  if (live.length === 0) {
    const inMain = herdr.terminals().filter((t) => herdr.isLive(t) && herdr.isAgent(t) && t.cwd === main);
    live = inMain.length === 1 ? inMain : [];
  }
  return live[0]?.address ?? "";
}

/**
 * With "mainSession": true in the main checkout's .hwt.json, refuse unless run from the main checkout. Guards new,
 * rm, and the main's own mailbox (inbox, ack, wait): a working session must not mark the main's mail handled.
 */
export function mainOnly(main: string, cmd: "new" | "rm" | "inbox" | "ack" | "wait"): void {
  if (process.env.HWT_ANYWHERE) return;
  if (!isMainSessionRepo(main)) return;
  if (samePath(toplevel(), main)) return;
  const sessions = herdr
    .terminals()
    .filter((t) => herdr.isLive(t) && herdr.isAgent(t) && t.cwd === main)
    .map((t) => t.address)
    .join(" ");
  die(messages(langFor(main)).mainOnly(main, cmd, sessions));
}
