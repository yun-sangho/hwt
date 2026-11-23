// Who the main session is, and the guard that keeps new/rm in it.
import { basename } from "./util.ts";
import { mainConfig, langFor } from "./config.ts";
import { samePath, toplevel } from "./git.ts";
import * as herdr from "./herdr.ts";
import { readLedger, updateLedger } from "./ledger.ts";
import { sessionFromEnv } from "./agents.ts";
import { messages } from "./messages.ts";
import { die, stamp } from "./util.ts";

export const mainLabel = (main: string) => `hwt.main=${basename(main)}`;

export function isMainSessionRepo(main: string): boolean {
  return mainConfig(main).mainSession === true;
}

/**
 * Mark this terminal as the repo's main session: label hwt.main=<repo> and record it in the ledger.
 * The label moves: whichever terminal held it before loses it, so one terminal is the main.
 */
export function claimMain(main: string): void {
  const me = herdr.myTerminal();
  if (!me) return;
  const label = mainLabel(main);
  for (const t of herdr.terminals(label)) if (t.address !== me) herdr.label(t.address, "hwt.main=");
  herdr.label(me, label);
  updateLedger(main, (l) => {
    l.main = { terminal: me, session: sessionFromEnv() || null, claimed: stamp() };
  });
}

/**
 * Address of the live main session: the newest live terminal labelled hwt.main=<repo>, else the terminal the
 * ledger recorded at the last claim if it is still live. Empty when neither (the main session is down): a
 * terminal's cwd is where it started, not where its agent works, so it never decides who the main is.
 */
export function resolveMain(main: string): string {
  const labelled = herdr.terminals(mainLabel(main)).filter(herdr.isLive);
  if (labelled.length) {
    const ms = (t: herdr.Terminal) => t.created_ms ?? herdr.terminal(t.address)?.created_ms ?? 0;
    return labelled.reduce((a, b) => (ms(b) > ms(a) ? b : a)).address;
  }
  const recorded = readLedger(main).main?.terminal;
  const t = recorded ? herdr.terminal(recorded) : null;
  return t && herdr.isLive(t) ? t.address : "";
}

/**
 * With "mainSession": true in the main checkout's .hwt.json, refuse unless run from the main checkout. Guards new,
 * rm, and the main's own mailbox (inbox, ack, wait): a working session must not mark the main's mail handled.
 */
export function mainOnly(main: string, cmd: "new" | "rm" | "inbox" | "ack" | "wait"): void {
  if (process.env.HWT_ANYWHERE) return;
  if (!isMainSessionRepo(main)) return;
  if (samePath(toplevel(), main)) return;
  die(messages(langFor(main)).mainOnly(main, cmd, resolveMain(main)));
}
