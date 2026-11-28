// Herdr: the desktop app (`herdr-app`: spaces, tabs) and its terminal core (`hc`: terminals, messages).
// hwt requires both. Every JSON shape hwt reads from them is typed here, in one place, so a change in
// Herdr's output is a change in this file only.
import { run, runOut, has, sleepMs } from "./util.ts";

export interface Terminal {
  address: string;
  name?: string | null;
  agent?: string | null;
  status?: string | { state?: string } | null;
  state?: string;
  cwd?: string;
  labels?: Record<string, string>;
  parent?: string | null;
  created_ms?: number;
}

export interface Space {
  id: string;
  name?: string | null;
  folder?: string;
  tabs?: { id: string; name?: string | null }[];
}

export function herdrInstalled(): boolean {
  return has("herdr-app") && has("hc");
}

/** The app's window is reachable (the app is running). */
export function herdrUp(): boolean {
  return herdrInstalled() && run(["herdr-app", "ls"]).ok;
}

function json<T>(cmd: string[]): T | null {
  const out = runOut(cmd);
  if (out === null) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

export function spaces(): Space[] {
  return json<{ spaces?: Space[] }>(["herdr-app", "ls"])?.spaces ?? [];
}

const under = (p: string | undefined, dir: string) => !!p && (p === dir || p.startsWith(dir + "/"));

/** Ids of spaces whose folder is <dir> or below it. */
export function spacesIn(dir: string): string[] {
  if (!herdrUp()) return [];
  return spaces()
    .filter((s) => under(s.folder, dir))
    .map((s) => s.id);
}

/** Run an app command with one JSON argument. Returns its parsed output, or null on failure. */
export function appDo<T = Record<string, unknown>>(command: string, arg: Record<string, unknown>): T | null {
  const r = run(["herdr-app", "do", command, JSON.stringify(arg)]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out) as T;
  } catch {
    return {} as T;
  }
}

export interface NewSpace {
  space: string;
  tab: string;
  terminal: string;
}

/**
 * A new space with one terminal in <folder>. Herdr starts argv through the person's login shell, so
 * their PATH (nvm, …) is there. Without argv the terminal is the person's own shell.
 */
export function newSpace(opts: { folder: string; name?: string; tab?: string; argv?: string[]; focus?: boolean }): {
  ok: true;
  value: NewSpace;
} | { ok: false; error: string } {
  const arg: Record<string, unknown> = { folder: opts.folder, focus: opts.focus ?? false };
  if (opts.name) arg.name = opts.name;
  if (opts.tab) arg.tab = opts.tab;
  if (opts.argv?.length) arg.argv = opts.argv;
  const r = run(["herdr-app", "do", "space.new", JSON.stringify(arg)]);
  try {
    const v = JSON.parse(r.out) as NewSpace;
    if (r.ok && v.terminal) return { ok: true, value: v };
  } catch {}
  return { ok: false, error: (r.err || r.out).trim() };
}

export function closeSpace(id: string): void {
  appDo("space.close", { id, confirmed: true });
}

export function selectSpace(id: string): void {
  appDo("space.select", { id });
}

/** A worktree's space name: its title, behind "pr-<n>" once it has a PR (the sidebar shows which PR it is). */
export const spaceName = (title: string, pr?: number | null): string => (pr ? `pr-${pr}${title ? ` ${title}` : ""}` : title);

export function renameSpace(id: string, name: string): void {
  appDo("space.rename", { id, name });
}

export function terminals(label?: string): Terminal[] {
  if (!has("hc")) return [];
  const cmd = ["hc", "ls", "--json"];
  if (label) cmd.push("--label", label);
  return json<{ terminals?: Terminal[] }>(cmd)?.terminals ?? [];
}

export function terminal(address: string): Terminal | null {
  return json<Terminal>(["hc", "get", address, "--json"]);
}

export function label(address: string, kv: string): void {
  run(["hc", "label", address, kv]);
}

/**
 * Send text to a terminal. A failed send is tried twice more while the terminal is still live (hc can fail
 * for a moment while a terminal is busy). False: it never went through, as far as hc says.
 */
export function send(address: string, text: string): boolean {
  for (let i = 0; i < 3; i++) {
    if (i) {
      sleepMs(700 * i);
      const t = terminal(address);
      if (!t || !isLive(t)) return false;
    }
    if (run(["hc", "send", address, text]).ok) return true;
  }
  return false;
}

export function kill(address: string): void {
  run(["hc", "kill", address]);
}

export function waitChildren(timeoutS: number): Record<string, unknown> | null {
  return json(["hc", "wait", "--children", "any", "--timeout", String(timeoutS), "--json"]);
}

export const isLive = (t: Terminal) => t.state === "live";
export const isAgent = (t: Terminal) => !!t.agent;
export const inDir = (t: Terminal, dir: string) => under(t.cwd, dir);

/** Status as a short word ("working", "done", …), whatever shape hc gave it. */
export function statusWord(t: Terminal): string | null {
  if (!t.status) return null;
  return typeof t.status === "string" ? t.status : (t.status.state ?? null);
}

export const myTerminal = () => process.env.HC_TERMINAL_ID || "";
