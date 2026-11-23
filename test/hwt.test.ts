// End-to-end tests: a throwaway git repo, the real CLI, and fake herdr-app/hc on PATH.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellWords, slug } from "../src/util.ts";
import type { FakeState } from "./fake/state.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FAKE = join(import.meta.dir, "fake");
chmodSync(join(FAKE, "herdr-app"), 0o755);
chmodSync(join(FAKE, "hc"), 0o755);

let dir: string;
let repo: string;
let env: Record<string, string>;

function sh(cmd: string[], cwd = repo) {
  const p = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
function hwt(args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) {
  const p = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    cwd: opts.cwd ?? repo,
    env: { ...env, ...opts.env },
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const json = (r: { out: string }) => JSON.parse(r.out);
const fake = (): FakeState => JSON.parse(readFileSync(env.HWT_FAKE_STATE!, "utf8"));
const ledger = () => JSON.parse(readFileSync(join(repo, ".git", "hwt", "ledger.json"), "utf8"));
const config = (c: object) => {
  writeFileSync(join(repo, ".hwt.json"), JSON.stringify(c));
  sh(["git", "add", "-A"]);
  sh(["git", "commit", "-qm", "config"]);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "hwt-test-")));
  repo = join(dir, "repo");
  env = {
    PATH: `${FAKE}:${process.env.PATH}`,
    HOME: dir,
    HWT_ROOT: join(dir, "wts"),
    HWT_FAKE_STATE: join(dir, "fake.json"),
    XDG_CONFIG_HOME: join(dir, "cfg"),
    HERDR_APP_HOME: join(dir, "herdr"),
    HWT_SELF: "hwt",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify({ seq: 100, spaces: [], terminals: [], sent: [], calls: [] }));
  sh(["git", "init", "-q", "-b", "main", repo], dir);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "init"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("util", () => {
  test("shellWords splits like a shell", () => {
    expect(shellWords(`claude --model "opus 5" -p 'it''s' a\\ b`)).toEqual(["claude", "--model", "opus 5", "-p", "its", "a b"]);
  });
  test("slug matches Herdr's rule", () => {
    expect(slug("feat/t14 slot-edit")).toBe("feat-t14-slot-edit");
  });
});

describe("new / rm", () => {
  test("--no-space: worktree, setup in sh, ledger; rm removes without teardown", () => {
    writeFileSync(join(repo, ".gitignore"), "setup.out\n");
    config({ setup: "echo SETUP > setup.out", teardown: "echo TD > /tmp/never" });
    const r = hwt(["new", "feat/x", "--no-space"]);
    expect(r.code).toBe(0);
    const o = json(r);
    expect(o).toMatchObject({ branch: "feat/x", created: true, space: null, setup: "ok" });
    expect(readFileSync(join(o.path, "setup.out"), "utf8")).toBe("SETUP\n");
    expect(ledger().worktrees["feat/x"].state).toBe("active");
    const rm = hwt(["rm", "feat/x", "-D", "--no-hooks"]);
    expect(rm.code).toBe(0);
    expect(json(rm)).toMatchObject({ branch: "feat/x", branch_deleted: true });
    expect(json(rm).teardown).toBeUndefined();
    expect(existsSync(o.path)).toBe(false);
    expect(ledger().worktrees["feat/x"].state).toBe("removed");
  });

  test("with Herdr: one space.new, setup before the agent, task last, worktree label", () => {
    config({ setup: "pnpm install", mainSession: true, lang: "ko" });
    const r = hwt(["new", "feat/y", "--title", "Y 작업", "--task", "do 'it'", "--name", "old", "--detach"]);
    expect(r.code).toBe(0);
    const o = json(r);
    expect(o).toMatchObject({ terminal: "t100", name: "feat-y", parent: null, setup: "in-space" });
    const call = fake().calls.find((c) => c.cmd === "space.new")!;
    expect(call.arg).toMatchObject({ folder: o.path, name: "Y 작업", tab: "feat-y", focus: false });
    const argv = call.arg.argv as string[];
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv[2]).toContain("pnpm install");
    expect(argv[2]).toEndWith('exec "$@"');
    expect(argv[4]).toBe("claude");
    expect(argv[5]).toBe("--session-id");
    expect(argv[6]).toBe(o.session);
    expect(argv.at(-1)).toStartWith("do 'it'\n\n[hwt] 메인 세션에는");
    expect(fake().terminals[0]!.labels["hwt.worktree"]).toBe("feat-y");
    expect(ledger().worktrees["feat/y"]).toMatchObject({ terminal: "t100", name: "feat-y", agent: "claude", title: "Y 작업" });
  });

  test("agent none without setup: no argv, Herdr opens the person's shell", () => {
    const r = hwt(["new", "feat/sh", "--agent", "none"]);
    expect(r.code).toBe(0);
    expect(fake().calls[0]!.arg.argv).toBeUndefined();
  });

  test("codex gets its worktree flags", () => {
    hwt(["new", "feat/cx", "--agent", "codex --model o5"]);
    const argv = fake().calls[0]!.arg.argv as string[];
    expect(argv[0]).toBe("codex");
    expect(argv).toContain("--no-daemon");
    expect(argv.slice(argv.indexOf("-C"), argv.indexOf("-C") + 2)[1]).toEndWith("/feat-cx");
    expect(argv).toContain("danger-full-access");
    expect(argv.slice(-2)).toEqual(["--model", "o5"]);
  });

  test("refuses when Herdr is down, unless --no-space", () => {
    const r = hwt(["new", "feat/z"], { env: { HWT_FAKE_DOWN: "1" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Herdr is not running");
    expect(existsSync(join(dir, "wts", "repo", "feat-z"))).toBe(false);
  });

  test("mainSession: new/rm only from the main checkout", () => {
    config({ mainSession: true });
    const wt = json(hwt(["new", "feat/a", "--no-space"])).path;
    const r = hwt(["new", "feat/b", "--no-space"], { cwd: wt });
    expect(r.code).toBe(1);
    expect(r.err).toContain("main session");
    expect(hwt(["new", "feat/b", "--no-space"], { cwd: wt, env: { HWT_ANYWHERE: "1" } }).code).toBe(0);
  });

  test("rm refuses while an agent is live in the checkout", () => {
    const o = json(hwt(["new", "feat/live"]));
    const r = hwt(["rm", "feat/live"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("agent terminals are live");
    const ok = hwt(["rm", "feat/live", "--kill-agents"]);
    expect(json(ok)).toMatchObject({ spaces_closed: 1, terminals_killed: 1 });
    expect(existsSync(o.path)).toBe(false);
  });
});

describe("main-session workflow", () => {
  test("tasks: add, decide, run via new --task-id, done", () => {
    config({ mainSession: true });
    const id = json(hwt(["task", "add", "T1", "first", "--touches", "src/"])).task;
    expect(hwt(["task", "decide", id, "now", "--why", "free"]).code).toBe(0);
    hwt(["new", "feat/t1", "--no-space", "--task-id", id, "--task", "go"]);
    const t = json(hwt(["task", "ls"]))[0];
    expect(t).toMatchObject({ id, title: "T1 first", state: "running", branch: "feat/t1", decision: "now" });
    expect(ledger().worktrees["feat/t1"].title).toBe("T1 first");
    expect(hwt(["task", "done", id]).code).toBe(0);
    expect(json(hwt(["task", "ls"]))).toEqual([]);
    expect(hwt(["task", "done", "T0"]).code).toBe(1);
  });

  test("tell from a worktree: inbox first, then the labelled main session; ack", () => {
    config({ mainSession: true });
    const wt = json(hwt(["new", "feat/w", "--no-space"])).path;
    // The main session runs in a terminal labelled hwt.main=repo.
    const s = fake();
    s.terminals.push({ address: "t1", name: null, agent: "claude-code", status: "done", state: "live", cwd: repo, labels: {}, parent: null, created_ms: 1 });
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(s));
    expect(json(hwt(["claim"], { env: { HC_TERMINAL_ID: "t1" } }))).toMatchObject({ main: "t1", label: "hwt.main=repo" });
    const r = json(hwt(["tell", "[merge request]", "please"], { cwd: wt, env: { CLAUDE_CODE_SESSION_ID: "abc" } }));
    expect(r).toMatchObject({ main: "t1", delivered: true, inbox: true });
    expect(fake().sent[0]!.text).toBe(`[merge request] please — feat-w (hwt inbox ${r.id})`);
    expect(ledger().worktrees["feat/w"].session).toBe("abc");
    expect(hwt(["inbox"]).out.trim().split("\n")).toHaveLength(1);
    hwt(["ack", "--all"]);
    expect(hwt(["inbox"]).out).toBe("");
    expect(hwt(["inbox", "--all"]).out.trim().split("\n")).toHaveLength(1);
  });

  test("only claim makes a terminal the main; new/rm leave it, a new claim moves it", () => {
    config({ mainSession: true });
    const s = fake();
    for (const address of ["t1", "t2"])
      s.terminals.push({ address, name: null, agent: "claude-code", status: "done", state: "live", cwd: repo, labels: {}, parent: null, created_ms: address === "t1" ? 1 : 2 });
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(s));
    const label = (t: string) => fake().terminals.find((x) => x.address === t)!.labels["hwt.main"];
    hwt(["claim"], { env: { HC_TERMINAL_ID: "t1" } });
    // Another terminal in the main checkout makes and removes a worktree: the main stays t1.
    expect(hwt(["new", "feat/c", "--no-space"], { env: { HC_TERMINAL_ID: "t2" } }).code).toBe(0);
    expect(hwt(["rm", "feat/c", "-D", "--no-hooks"], { env: { HC_TERMINAL_ID: "t2" } }).code).toBe(0);
    expect(label("t2")).toBeUndefined();
    expect(hwt(["main"]).out.trim()).toBe("t1");
    // An explicit claim moves the label: one terminal holds it.
    hwt(["claim"], { env: { HC_TERMINAL_ID: "t2" } });
    expect(label("t1")).toBeUndefined();
    expect(label("t2")).toBe("repo");
    expect(ledger().main.terminal).toBe("t2");
  });

  test("the main is found by label or ledger, never by a terminal that merely started in the repo", () => {
    config({ mainSession: true });
    const wt = json(hwt(["new", "feat/r", "--no-space"])).path;
    const s = fake();
    // t1 is the main but its terminal started elsewhere; t9 is an unrelated agent that started in the repo.
    s.terminals.push(
      { address: "t1", name: null, agent: "claude-code", status: "done", state: "live", cwd: dir, labels: {}, parent: null, created_ms: 1 },
      { address: "t9", name: null, agent: "codex", status: "done", state: "live", cwd: repo, labels: {}, parent: null, created_ms: 2 },
    );
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(s));
    hwt(["claim"], { env: { HC_TERMINAL_ID: "t1" } });
    const refused = hwt(["inbox"], { cwd: wt });
    expect(refused.err).toContain("main session now: t1");
    expect(refused.err).not.toContain("t9");
    // The label is gone (say Herdr restarted it): the ledger's live main still gets the message.
    const t = fake();
    t.terminals.find((x) => x.address === "t1")!.labels = {};
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(t));
    expect(json(hwt(["tell", "[decision] a"], { cwd: wt }))).toMatchObject({ main: "t1", delivered: true });
    // The main is gone: the message stays in the inbox instead of going to t9.
    const u = fake();
    u.terminals.find((x) => x.address === "t1")!.state = "exited";
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(u));
    expect(json(hwt(["tell", "[decision] b"], { cwd: wt }))).toMatchObject({ main: null, delivered: false, inbox: true });
    expect(fake().sent.map((m) => m.to)).toEqual(["t1"]);
  });

  test("merge queue: add from the worktree, approval paths, approve, set", () => {
    config({ mainSession: true, mergeApproval: { paths: ["db/**", "AGENTS.md"] } });
    const wt = json(hwt(["new", "feat/m", "--no-space"])).path;
    sh(["mkdir", "-p", "db"], wt);
    writeFileSync(join(wt, "db", "schema.sql"), "x\n");
    sh(["git", "add", "."], wt);
    sh(["git", "commit", "-qm", "schema"], wt);
    const add = json(hwt(["mq", "add", "schema", "change"], { cwd: wt }));
    expect(add).toMatchObject({ branch: "feat/m", state: "queued" });
    let n = json(hwt(["mq", "next"])).next;
    expect(n.checks).toMatchObject({ approval: "user", approval_why: ["db/**: db/schema.sql"], ahead: 1, behind: 0, conflict: false, ready: true });
    expect(n.may_merge).toBe(false);
    hwt(["mq", "set", add.merge, "waiting_user", "--why", "schema"]);
    expect(json(hwt(["mq", "next"])).waiting_user[0]).toMatchObject({ id: add.merge });
    hwt(["mq", "approve", add.merge]);
    n = json(hwt(["mq", "next"])).next;
    expect(n.may_merge).toBe(true);
    hwt(["mq", "set", add.merge, "merging"]);
    expect(json(hwt(["mq", "next"])).busy.id).toBe(add.merge);
    expect(hwt(["mq", "set", add.merge, "bogus"]).code).toBe(1);
  });

  test("inbox, ack and wait are the main's: refused in a working worktree", () => {
    config({ mainSession: true, lang: "ko" });
    const wt = json(hwt(["new", "feat/q", "--no-space"])).path;
    for (const cmd of [["inbox"], ["ack", "--all"], ["wait", "--timeout", "1"]]) {
      const r = hwt(cmd, { cwd: wt });
      expect(r.code).toBe(1);
      expect(r.err).toContain("hwt tell");
      expect(r.err).toContain("gh pr view");
    }
    expect(hwt(["inbox"]).code).toBe(0);
  });

  test("worker instructions say how to wait for the merge", () => {
    config({ mainSession: true });
    hwt(["new", "feat/i", "--task", "go"]);
    const task = (fake().calls[0]!.arg.argv as string[]).at(-1)!;
    expect(task).toContain("gh pr view <n> --json state");
    expect(task).toContain("[rebase request]");
  });

  test("--help prints usage and adds nothing", () => {
    const r = hwt(["task", "add", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith("usage: hwt task add");
    expect(json(hwt(["task", "ls", "--all"]))).toEqual([]);
    for (const cmd of [["task", "add", "--help"], ["mq", "add", "-h"], ["new", "--help"]]) {
      const out = hwt(cmd, { cwd: dir }); // outside any git repo (what brew test does)
      expect(out.code).toBe(0);
      expect(out.out).toStartWith("usage:");
    }
  });

  test("note: --help and stray options write nothing; --drop removes a wrong note", () => {
    config({ mainSession: true });
    for (const cmd of [["note", "--help"], ["note", "-h"], ["task", "--help"], ["mq", "-h"]]) {
      const r = hwt(cmd);
      expect(r.code).toBe(0);
      expect(r.out).toStartWith("usage: hwt");
    }
    expect(hwt(["note", "--bogus", "x"]).code).toBe(1);
    expect(existsSync(join(repo, ".git", "hwt", "ledger.json")) ? ledger().notes : []).toEqual([]);
    hwt(["note", "keep"]);
    hwt(["note", "typo"]);
    hwt(["note", "also keep"]);
    expect(hwt(["note", "--drop", "9"]).code).toBe(1);
    expect(json(hwt(["note", "--drop", "2"]))).toMatchObject({ dropped: { text: "typo" } });
    expect(ledger().notes.map((n: { text: string }) => n.text)).toEqual(["keep", "also keep"]);
  });

  test("note and status", () => {
    config({ mainSession: true });
    hwt(["new", "feat/s", "--no-space", "--title", "S"]);
    hwt(["note", "--branch", "feat/s", "merge it when green"]);
    const st = json(hwt(["status"]));
    expect(st.notes[0]).toMatchObject({ branch: "feat/s", text: "merge it when green" });
    expect(st.worktrees[0]).toMatchObject({ worktree: "feat-s", label: "feat-s (S)", branch: "feat/s" });
  });
});

describe("tools", () => {
  test("init guesses setup from the lockfile", () => {
    writeFileSync(join(repo, "pnpm-lock.yaml"), "");
    const r = json(hwt(["init", "--main-session", "--lang", "ko"]));
    expect(r.config).toMatchObject({ version: 1, setup: "pnpm install", mainSession: true, lang: "ko" });
    expect(hwt(["init"]).code).toBe(1);
  });

  test("doctor reports required tools and a leftover teardown", () => {
    config({ teardown: "x" });
    const r = hwt(["doctor"]);
    const d = json(r);
    expect(d.ok).toBe(true);
    expect(d.checks.find((c: { name: string }) => c.name === "repo config").ok).toBe(false);
  });

  test("hook session-start: main and worker briefings, silent elsewhere", () => {
    expect(hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: repo }) }).out).toBe("");
    config({ mainSession: true });
    const wt = json(hwt(["new", "feat/h", "--no-space"])).path;
    const m = hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: repo }) });
    expect(m.out).toContain("main session of repo");
    expect(m.out).toContain('"branch":"feat/h"');
    const w = hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: wt }) });
    expect(w.out).toContain("working session of repo (worktree feat-h, branch feat/h)");
  });

  test("shell-init prints a wrapper", () => {
    expect(hwt(["shell-init", "bash"]).out).toContain("command hwt");
    expect(hwt(["shell-init", "fish"]).out).toContain("function hwt");
  });
});
