// The merge-queue daemon: one process per computer that keeps every repo's merge queue moving.
//
//   repos     every git repo whose ledger hwt wrote is remembered in ~/.local/state/hwt/repos.json; the daemon
//             looks at those, skips ones that are gone, and forgets them.
//   pass      for each repo with work in its queue (queued, updating, approved, in flight), one runQueue pass
//             with the same plan, approvals and notifications as `hwt mq run`. A repo whose lease a live
//             runner holds (a main running `hwt mq run --watch`) is left to that runner.
//   one only  ~/.local/state/hwt/mq-daemon.json names the live daemon; a second one exits.
//   service   `hwt mq daemon install` keeps it running with launchd (macOS); anywhere, it runs in a terminal.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { worktreesRoot } from "./config.ts";
import { gitOut } from "./git.ts";
import { isGit } from "./project.ts";
import { readLedger } from "./ledger.ts";
import { IN_FLIGHT, leaseLive, runQueue, type RunEvent } from "./mq.ts";
import { die, run, shellWords, sleepMs, stamp } from "./util.ts";
import { selfCommand } from "./messages.ts";
import { forgetRepos, knownRepos, readJson, rememberRepo, stateHome, writeJson } from "./repos.ts";

const daemonFile = () => join(stateHome(), "mq-daemon.json");


// ---- The one daemon -----------------------------------------------------------------------

export interface DaemonInfo {
  pid: number;
  host: string;
  since: string;
  /** Last time it started a round (ms). */
  beat: number;
  interval: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running daemon, or null. One on another host (a shared home) counts while it beats. */
export function liveDaemon(): DaemonInfo | null {
  const d = readJson<DaemonInfo | null>(daemonFile(), null);
  if (!d || typeof d.pid !== "number") return null;
  if (d.host === hostname()) return pidAlive(d.pid) ? d : null;
  return Date.now() - d.beat < Math.max(3 * d.interval * 1000, 10 * 60_000) ? d : null;
}

/** Work the daemon would do in this repo now. waiting_user without approval waits for a person. */
function hasWork(main: string): boolean {
  const l = readLedger(main);
  return (l.merges ?? []).some(
    (x) => IN_FLIGHT.includes(x.state) || x.state === "queued" || x.state === "updating" || (x.state === "waiting_user" && !!x.approved),
  );
}

/**
 * Repos that have worktrees under the worktrees root (<root>/<repo>/<worktree>) and a ledger, for repos hwt used
 * before it kept repos.json. Their main checkout: the folder above the git common dir.
 */
export function discoverRepos(): void {
  const root = worktreesRoot();
  let repos: string[];
  try {
    repos = readdirSync(root);
  } catch {
    return;
  }
  for (const r of repos) {
    let wts: string[];
    try {
      wts = readdirSync(join(root, r));
    } catch {
      continue;
    }
    for (const w of wts) {
      const common = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], join(root, r, w));
      if (!common) continue;
      if (existsSync(join(common, "hwt", "ledger.json"))) rememberRepo(dirname(common));
      break;
    }
  }
}

export interface DaemonOptions {
  interval: number;
  once: boolean;
  remove: (main: string, branch: string) => void;
}

const log = (line: string) => process.stderr.write(`${stamp()} ${line}\n`);

/** One round over every known repo. Returns what moved, per repo. */
export function daemonRound(o: DaemonOptions): { repo: string; events?: RunEvent[]; merged?: string[]; skipped?: string; error?: string }[] {
  const out: ReturnType<typeof daemonRound> = [];
  const gone: string[] = [];
  for (const main of knownRepos()) {
    if (!existsSync(main) || !isGit(main)) {
      gone.push(main);
      continue;
    }
    try {
      if (!hasWork(main)) continue;
      if (leaseLive(readLedger(main).mq?.lease)) {
        out.push({ repo: main, skipped: "another runner holds the queue" });
        continue;
      }
      const r = runQueue(main, {
        watch: false, interval: o.interval, timeout: 0, dryRun: false, by: `daemon@${hostname()}`,
        remove: (branch) => o.remove(main, branch),
      });
      out.push({ repo: main, events: r.events, merged: r.merged });
    } catch (e) {
      out.push({ repo: main, error: (e as Error).message });
    }
  }
  forgetRepos(gone);
  return out;
}

/**
 * Run until killed (or one round with once). It doesn't trap signals: the runner is synchronous, and an item cut
 * off mid-merge is picked up again from its state (merging/verifying/cleaning) on the next round.
 */
export function runDaemon(o: DaemonOptions): void {
  const other = liveDaemon();
  if (other && other.pid !== process.pid) {
    log(`another merge-queue daemon is running (pid ${other.pid} on ${other.host}, since ${other.since}); exiting`);
    return;
  }
  const me: DaemonInfo = { pid: process.pid, host: hostname(), since: stamp(), beat: Date.now(), interval: o.interval };
  writeJson(daemonFile(), me);
  discoverRepos();
  log(`merge-queue daemon up (pid ${me.pid}, every ${o.interval}s, ${knownRepos().length} repos)`);
  try {
    for (;;) {
      const cur = readJson<DaemonInfo | null>(daemonFile(), null);
      if (cur && (cur.pid !== me.pid || cur.host !== me.host)) {
        log(`another daemon took over (pid ${cur.pid}); exiting`);
        return;
      }
      writeJson(daemonFile(), { ...me, beat: Date.now() });
      for (const r of daemonRound(o)) {
        if (r.error) log(`${r.repo}: ${r.error}`);
        for (const e of r.events ?? []) log(`${r.repo}: ${e.id} ${e.branch} ${e.from} → ${e.to}${e.why ? ` (${e.why})` : ""}`);
      }
      if (o.once) return;
      sleepMs(o.interval * 1000);
    }
  } finally {
    const cur = readJson<DaemonInfo | null>(daemonFile(), null);
    if (cur?.pid === me.pid && cur.host === me.host) rmSync(daemonFile(), { force: true });
  }
}

// ---- launchd (macOS) ----------------------------------------------------------------------

export const LABEL = "dev.hwt.mq-daemon";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const daemonLog = () => join(homedir(), "Library", "Logs", "hwt", "mq-daemon.log");

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The hwt to start: an absolute path (launchd has no PATH lookup for the program). */
function selfArgv(): string[] {
  const words = shellWords(selfCommand());
  if (words[0]!.startsWith("/")) return words;
  const found = Bun.which(words[0]!);
  if (found) return [found, ...words.slice(1)];
  // Not on PATH: this very hwt (a compiled binary, or bun with the script).
  return /\/bun(-\w+)?$/.test(process.execPath) ? [process.execPath, process.argv[1]!] : [process.execPath];
}

export function plist(interval: number): string {
  const args = [...selfArgv(), "mq", "daemon", "--interval", String(interval)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(daemonLog())}</string>
  <key>StandardErrorPath</key><string>${xml(daemonLog())}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${userInfo().uid}`;

export function installService(interval: number): { plist: string; log: string; loaded: boolean } {
  if (process.platform !== "darwin") die("hwt mq daemon install uses launchd (macOS). Elsewhere run `hwt mq daemon` in a terminal or a systemd user service");
  const f = plistPath();
  mkdirSync(dirname(f), { recursive: true });
  mkdirSync(dirname(daemonLog()), { recursive: true });
  run(["launchctl", "bootout", `${domain()}/${LABEL}`]);
  writeFileSync(f, plist(interval));
  const r = run(["launchctl", "bootstrap", domain(), f]);
  if (!r.ok) die(`launchctl bootstrap failed: ${(r.err || r.out).trim()}`);
  return { plist: f, log: daemonLog(), loaded: true };
}

export function uninstallService(): { plist: string; removed: boolean } {
  if (process.platform !== "darwin") die("hwt mq daemon uninstall uses launchd (macOS)");
  const f = plistPath();
  run(["launchctl", "bootout", `${domain()}/${LABEL}`]);
  const had = existsSync(f);
  rmSync(f, { force: true });
  return { plist: f, removed: had };
}

export function serviceInstalled(): boolean {
  return existsSync(plistPath());
}
