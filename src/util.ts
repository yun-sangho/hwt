// Small helpers shared by every command: running programs, errors, time stamps, ids, quoting.
import { homedir } from "node:os";

export class HwtError extends Error {}

/** Stop the command: the CLI prints `hwt: <msg>` on stderr and exits 1. */
export function die(msg: string): never {
  throw new HwtError(msg);
}

export function warn(msg: string): void {
  process.stderr.write(`hwt: ${msg}\n`);
}

export interface RunResult {
  ok: boolean;
  code: number;
  out: string;
  err: string;
}

export interface RunOptions {
  cwd?: string;
  stdin?: string;
  /** Send the program's stdout and stderr to our stderr instead of capturing them (hooks, git noise). */
  passthrough?: boolean;
  env?: Record<string, string | undefined>;
}

/** Run a program (no shell) and wait for it. Never throws for a non-zero exit or a missing program. */
export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  try {
    const p = Bun.spawnSync({
      cmd,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: opts.passthrough ? 2 : "pipe",
      stderr: opts.passthrough ? 2 : "pipe",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // With passthrough, Bun hands back the fd number instead of the captured bytes.
    const text = (b: unknown) => (b instanceof Uint8Array ? new TextDecoder().decode(b) : "");
    const out = text(p.stdout);
    const err = text(p.stderr);
    return { ok: p.exitCode === 0, code: p.exitCode ?? 1, out, err };
  } catch (e) {
    return { ok: false, code: 127, out: "", err: String(e) };
  }
}

/** Run and return trimmed stdout, or null on failure. */
export function runOut(cmd: string[], opts: RunOptions = {}): string | null {
  const r = run(cmd, opts);
  return r.ok ? r.out.replace(/\n+$/, "") : null;
}

export function has(program: string): boolean {
  return Bun.which(program) !== null;
}

/** 2026-11-22T22:39:22+0900: local time with its offset, as the ledger has always stored it. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(a / 60))}${p(a % 60)}`
  );
}

/** Short ids like T5580917: a prefix, the last five digits of the epoch seconds, two random digits. */
export function shortId(prefix: string): string {
  const s = String(Math.floor(Date.now() / 1000)).slice(-5);
  return `${prefix}${s}${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;
}

/** Inbox ids: epoch seconds and a random number, unique enough for one repo's inbox. */
export function inboxId(): string {
  return `${Math.floor(Date.now() / 1000)}-${Math.floor(Math.random() * 32768)}`;
}

/** Quote for POSIX sh: 'it'\''s'. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Split a command line the way a shell would split plain words and quotes (no expansion). */
export function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (q) die(`unterminated quote in: ${s}`);
  if (inWord) words.push(cur);
  return words;
}

/** Same rule as Herdr's New worktree: anything outside [A-Za-z0-9._-] becomes one dash, trimmed. */
export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

export function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() ?? p;
}

export function sleepMs(ms: number): void {
  Bun.sleepSync(ms);
}

/** One JSON object on one line: the stdout contract of most commands. */
export function printJson(v: unknown, pretty = false): void {
  process.stdout.write(JSON.stringify(v, null, pretty ? 2 : undefined) + "\n");
}
