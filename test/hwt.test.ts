// End-to-end tests: a throwaway git repo, the real CLI, and fake herdr-app/hc on PATH.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellWords, slug } from "../src/util.ts";
import type { FakePr, FakeState } from "./fake/state.ts";

setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FAKE = join(import.meta.dir, "fake");
chmodSync(join(FAKE, "herdr-app"), 0o755);
chmodSync(join(FAKE, "hc"), 0o755);
chmodSync(join(FAKE, "gh"), 0o755);

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
    expect(argv.at(-1)).toStartWith("do 'it'\n\n[hwt] 메인 세션에 진행 상황");
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

  const terminal = (address: string, cwd: string, created_ms = 1) => {
    const s = fake();
    s.terminals.push({ address, name: null, agent: "claude-code", status: "done", state: "live", cwd, labels: {}, parent: null, created_ms });
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(s));
  };
  const as = (t: string) => ({ env: { HC_TERMINAL_ID: t } });

  test("tell from a worktree: inbox first, then the main that made it; ack", () => {
    config({ mainSession: true });
    terminal("t1", repo);
    expect(json(hwt(["claim"], as("t1")))).toMatchObject({ id: "t1", terminal: "t1", path: repo, promoted_from: null });
    const wt = json(hwt(["new", "feat/w", "--no-space"], as("t1"))).path;
    expect(ledger().worktrees["feat/w"].owner).toBe("t1");
    const r = json(hwt(["tell", "[merge request]", "please"], { cwd: wt, env: { CLAUDE_CODE_SESSION_ID: "abc" } }));
    expect(r).toMatchObject({ main: "t1", owner: "t1", delivered: true, inbox: true });
    expect(fake().sent[0]!.text).toBe(`[merge request] please — feat-w (hwt inbox ${r.id})`);
    expect(ledger().worktrees["feat/w"].session).toBe("abc");
    expect(hwt(["inbox"], as("t1")).out.trim().split("\n")).toHaveLength(1);
    hwt(["ack", "--all"], as("t1"));
    expect(hwt(["inbox"], as("t1")).out).toBe("");
    expect(hwt(["inbox", "--all"], as("t1")).out.trim().split("\n")).toHaveLength(1);
  });

  test("several mains: each keeps its label, gets only its own worktrees' mail, tasks and merges", () => {
    config({ mainSession: true });
    terminal("t1", repo, 1);
    terminal("t2", repo, 2);
    const label = (t: string) => fake().terminals.find((x) => x.address === t)!.labels["hwt.main"];
    hwt(["claim"], as("t1"));
    hwt(["claim"], as("t2"));
    expect([label("t1"), label("t2")]).toEqual(["repo", "repo"]);
    const w1 = json(hwt(["new", "feat/a", "--no-space"], as("t1"))).path;
    const w2 = json(hwt(["new", "feat/b", "--no-space"], as("t2"))).path;
    hwt(["tell", "[decision] a"], { cwd: w1 });
    hwt(["tell", "[decision] b"], { cwd: w2 });
    expect(fake().sent.map((m) => [m.to, m.text.split(" —")[0]])).toEqual([["t1", "[decision] a"], ["t2", "[decision] b"]]);
    const inbox = (t: string) => hwt(["inbox"], as(t)).out.trim().split("\n").map((l) => JSON.parse(l).text);
    expect(inbox("t1")).toEqual(["[decision] a"]);
    expect(inbox("t2")).toEqual(["[decision] b"]);
    // ack --all acks only one's own mail.
    hwt(["ack", "--all"], as("t1"));
    expect(inbox("t2")).toEqual(["[decision] b"]);
    // Tasks: a main's, and a worktree's proposal, belong to that main; --every-main shows the others'.
    hwt(["task", "add", "mine"], as("t1"));
    hwt(["task", "add", "proposal"], { cwd: w2 });
    const titles = (args: string[], t: string) => json(hwt(["task", "ls", ...args], as(t))).map((x: { title: string }) => x.title);
    expect(titles([], "t1")).toEqual(["mine"]);
    expect(titles([], "t2")).toEqual(["proposal"]);
    expect(titles(["--every-main"], "t1")).toEqual(["mine", "proposal"]);
    // One merge queue: t2's merge in flight blocks t1, and t1 never picks t2's item.
    for (const w of [w1, w2]) {
      writeFileSync(join(w, "f"), w);
      sh(["git", "add", "."], w);
      sh(["git", "commit", "-qm", "f"], w);
    }
    const m1 = json(hwt(["mq", "add"], { cwd: w1 })).merge;
    const m2 = json(hwt(["mq", "add"], { cwd: w2 })).merge;
    expect(json(hwt(["mq", "next"], as("t2"))).next.id).toBe(m2);
    expect(json(hwt(["mq", "next"], as("t1"))).next.id).toBe(m1);
    hwt(["mq", "set", m2, "merging"], as("t2"));
    expect(json(hwt(["mq", "next"], as("t1"))).busy.id).toBe(m2);
    const st = json(hwt(["status"], as("t1")));
    expect(st.mains.map((x: { id: string; me: boolean }) => [x.id, x.me])).toEqual([["t1", true], ["t2", false]]);
    expect(st.worktrees.map((x: { branch: string; mine: boolean }) => [x.branch, x.mine])).toEqual([["feat/a", true], ["feat/b", false]]);
  });

  test("a main is found by its ledger record, never by a terminal that merely started in the repo; adopt", () => {
    config({ mainSession: true });
    // t1 is a main but its terminal started elsewhere; t9 is an unrelated agent that started in the repo.
    terminal("t1", dir, 1);
    terminal("t9", repo, 2);
    hwt(["claim"], as("t1"));
    const wt = json(hwt(["new", "feat/r", "--no-space"], as("t1"))).path;
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
    expect(json(hwt(["tell", "[decision] b"], { cwd: wt }))).toMatchObject({ main: null, owner: "t1", delivered: false, inbox: true });
    expect(fake().sent.map((m) => m.to)).toEqual(["t1"]);
    // Another main takes the worktree over, with its unread mail.
    terminal("t2", repo, 3);
    hwt(["claim"], as("t2"));
    expect(hwt(["inbox"], as("t2")).out).toBe("");
    expect(json(hwt(["adopt", "feat-r"], as("t2")))).toMatchObject({ owner: "t2", adopted: [{ branch: "feat/r", from: "t1" }] });
    expect(hwt(["inbox"], as("t2")).out.trim().split("\n")).toHaveLength(2);
    expect(json(hwt(["tell", "[decision] c"], { cwd: wt }))).toMatchObject({ main: "t2", delivered: true });
    expect(hwt(["adopt", "nope"], as("t2")).code).toBe(1);
  });

  test("a new agent session in a main's terminal takes over its worktrees", () => {
    config({ mainSession: true });
    terminal("t1", repo);
    hwt(["claim"], { env: { HC_TERMINAL_ID: "t1", CLAUDE_CODE_SESSION_ID: "s1" } });
    hwt(["new", "feat/k", "--no-space"], { env: { HC_TERMINAL_ID: "t1", CLAUDE_CODE_SESSION_ID: "s1" } });
    expect(ledger().worktrees["feat/k"].owner).toBe("s1");
    const c = json(hwt(["claim"], { env: { HC_TERMINAL_ID: "t1", CLAUDE_CODE_SESSION_ID: "s2" } }));
    expect(c).toMatchObject({ id: "s2", took_over: ["s1"] });
    expect(Object.keys(ledger().mains)).toEqual(["s2"]);
    expect(ledger().worktrees["feat/k"].owner).toBe("s2");
  });

  test("a working session becomes a main of its own with claim in its worktree", () => {
    config({ mainSession: true });
    terminal("t1", repo);
    hwt(["claim"], as("t1"));
    const wt = json(hwt(["new", "feat/p", "--no-space"], as("t1"))).path;
    terminal("w1", wt, 2);
    // Before the claim it is a working session: no worktrees of its own.
    expect(hwt(["new", "feat/p-sub", "--no-space"], { cwd: wt, ...as("w1") }).code).toBe(1);
    expect(json(hwt(["claim"], { cwd: wt, ...as("w1") }))).toMatchObject({ id: "w1", path: wt, promoted_from: "t1" });
    expect(ledger().worktrees["feat/p"].owner).toBe("w1");
    // Its old main has it in its log, but isn't interrupted: there is nothing for it to decide.
    expect(fake().sent.filter((m) => m.to === "t1")).toEqual([]);
    expect(hwt(["inbox"], as("t1")).out).toBe("");
    expect(hwt(["inbox", "--log"], as("t1")).out).toContain("[now a main] feat-p (feat/p)");
    // Now it makes worktrees of its own, off its branch, and their mail comes to it.
    const sub = json(hwt(["new", "feat/p-sub", "--no-space"], { cwd: wt, ...as("w1") }));
    expect(sub.owner).toBe("w1");
    expect(json(hwt(["tell", "[decision] x"], { cwd: sub.path }))).toMatchObject({ main: "w1", delivered: true });
    expect(hwt(["inbox"], { cwd: wt, ...as("w1") }).out).toContain("[decision] x");
    expect(hwt(["inbox"], as("t1")).out).not.toContain("[decision] x");
    // Its own merge request is its own, not t1's.
    writeFileSync(join(wt, "g"), "g");
    sh(["git", "add", "."], wt);
    sh(["git", "commit", "-qm", "g"], wt);
    hwt(["mq", "add"], { cwd: wt, ...as("w1") });
    expect(json(hwt(["mq", "next"], as("t1"))).next).toBeNull();
    expect(json(hwt(["mq", "next"], { cwd: wt, ...as("w1") })).next.branch).toBe("feat/p");
  });

  test("mains prune: forgets gone mains, keeps ones that own worktrees unless --release", () => {
    config({ mainSession: true });
    terminal("t1", repo, 1);
    terminal("t2", repo, 2);
    terminal("t3", repo, 3);
    for (const t of ["t1", "t2", "t3"]) hwt(["claim"], as(t));
    hwt(["new", "feat/o", "--no-space"], as("t2"));
    hwt(["note", "t2's note"], as("t2"));
    const s = fake();
    for (const t of s.terminals) if (t.address !== "t1") t.state = "exited";
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(s));
    expect(json(hwt(["mains"], as("t1"))).map((m: { id: string; live: boolean; owns: string[] }) => [m.id, m.live, m.owns])).toEqual([
      ["t1", true, []], ["t2", false, ["feat/o"]], ["t3", false, []],
    ]);
    expect(json(hwt(["mains", "prune", "--dry-run"], as("t1")))).toMatchObject({ pruned: ["t3"], dry_run: true });
    expect(Object.keys(ledger().mains)).toEqual(["t1", "t2", "t3"]);
    expect(json(hwt(["mains", "prune"], as("t1")))).toMatchObject({ pruned: ["t3"], kept_owning_worktrees: [{ id: "t2", owns: ["feat/o"] }] });
    expect(Object.keys(ledger().mains)).toEqual(["t1", "t2"]);
    expect(json(hwt(["mains", "prune", "--release"], as("t1")))).toMatchObject({ pruned: ["t2"], released: ["feat/o"] });
    expect(Object.keys(ledger().mains)).toEqual(["t1"]);
    expect(ledger().worktrees["feat/o"].owner).toBeNull();
    // Unowned now: t1 sees its note and its worktree.
    expect(json(hwt(["status"], as("t1"))).notes.map((n: { text: string }) => n.text)).toEqual(["t2's note"]);
    expect(hwt(["mains", "bogus"]).code).toBe(1);
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

describe("merge queue runner", () => {
  let origin: string;
  const t1 = { env: { HC_TERMINAL_ID: "t1" } };
  const setFake = (f: (s: FakeState) => void) => {
    const s = fake();
    f(s);
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(s));
  };
  const pr = (n: number, head: string, checks: FakePr["checks"] = "pass") =>
    setFake((s) => {
      s.prs = { ...s.prs, [n]: { head, base: "main", state: "OPEN", checks } };
    });
  const checks = (n: number, c: FakePr["checks"]) => setFake((s) => void (s.prs![n]!.checks = c));
  /** A worktree owned by t1 with one pushed commit and a PR. */
  const work = (branch: string, n: number, file = branch.replace("/", "-"), body = "x\n") => {
    const wt = json(hwt(["new", branch, "--no-space"], t1)).path;
    writeFileSync(join(wt, file), body);
    sh(["git", "add", "."], wt);
    sh(["git", "commit", "-qm", branch], wt);
    sh(["git", "push", "-q", "-u", "origin", branch], wt);
    pr(n, branch);
    expect(hwt(["mq", "add", "--pr", String(n)], { cwd: wt }).code).toBe(0);
    return wt;
  };
  const originMain = (f: string) => sh(["git", "-C", origin, "show", `main:${f}`]);
  const originBranch = (branch: string) => sh(["git", "-C", origin, "rev-parse", "--verify", "-q", branch]);
  const run = (...a: string[]) => json(hwt(["mq", "run", ...a], t1));
  const item = (branch: string) => ledger().merges.filter((m: { branch: string; state: string }) => m.branch === branch && m.state !== "dropped").at(-1);
  const completeNativeMerge = (n: number, branch: string) => {
    const sha = originBranch(branch).out.trim();
    const base = fake().prs![n]!.base;
    expect(sh(["git", "-C", origin, "update-ref", `refs/heads/${base}`, sha]).code).toBe(0);
    setFake((s) => Object.assign(s.prs![n]!, { state: "MERGED", sha }));
    return sha;
  };

  beforeEach(() => {
    origin = join(dir, "origin.git");
    sh(["git", "init", "-q", "--bare", "-b", "main", origin], dir);
    sh(["git", "remote", "add", "origin", origin]);
    sh(["git", "push", "-q", "-u", "origin", "main"]);
    sh(["git", "remote", "set-head", "origin", "main"]);
    env.HWT_FAKE_ORIGIN = origin;
    config({ mainSession: true, mergeApproval: { paths: ["db/**"] } });
    sh(["git", "push", "-q", "origin", "main"]);
    setFake((s) => s.terminals.push({ address: "t1", name: null, agent: "claude-code", status: "done", state: "live", cwd: repo, labels: {}, parent: null, created_ms: 1 }));
    hwt(["claim"], t1);
  });

  test("merges, verifies and cleans up; the main checkout follows the base; the task is done", () => {
    config({ mainSession: true, mergeQueue: { verify: "test -n \"$HWT_MQ_SHA\"", gc: "touch gc-ran" } });
    sh(["git", "push", "-q", "origin", "main"]);
    const task = json(hwt(["task", "add", "A"], t1)).task;
    const wt = json(hwt(["new", "feat/a", "--no-space", "--task-id", task], t1)).path;
    writeFileSync(join(wt, "a"), "a\n");
    sh(["git", "add", "."], wt);
    sh(["git", "commit", "-qm", "a"], wt);
    sh(["git", "push", "-q", "-u", "origin", "feat/a"], wt);
    pr(1, "feat/a");
    hwt(["mq", "add", "--pr", "1"], { cwd: wt });
    const r = run();
    expect(r.merged).toEqual(["feat/a"]);
    expect(r.events.map((e: { to: string }) => e.to)).toEqual(["merging", "verifying", "cleaning", "done"]);
    expect(originMain("a").out).toBe("a\n");
    expect(existsSync(wt)).toBe(false);
    expect(sh(["git", "-C", origin, "rev-parse", "--verify", "-q", "feat/a"]).code).not.toBe(0);
    expect(existsSync(join(repo, "gc-ran"))).toBe(true);
    expect(readFileSync(join(repo, "a"), "utf8")).toBe("a\n"); // fast-forwarded
    expect(json(hwt(["task", "ls", "--all"], t1))[0].state).toBe("done");
    expect(json(hwt(["mq", "log", item("feat/a").id])).history.map((h: { to: string }) => h.to)).toEqual(["queued", "merging", "verifying", "cleaning", "done"]);
    expect(ledger().mq.lease).toBeNull();
  });

  test("an accepted GitHub merge queue entry preserves the worktree until the PR merges", () => {
    const wt = work("feat/native", 1);
    setFake((s) => void (s.prs![1]!.mergeQueue = "required"));

    const pending = run();
    expect(pending.merged).toEqual([]);
    expect(pending.waiting).toEqual([
      { id: item("feat/native").id, branch: "feat/native", state: "merging", step: expect.objectContaining({ act: "wait" }) },
    ]);
    expect(item("feat/native").state).toBe("merging");
    expect(existsSync(wt)).toBe(true);
    expect(originBranch("feat/native").code).toBe(0);
    expect(originMain("feat-native").code).not.toBe(0);

    expect(run().merged).toEqual([]);
    expect(fake().calls.filter((c) => c.cmd === "gh pr merge")).toHaveLength(1);

    const sha = completeNativeMerge(1, "feat/native");
    expect(run().merged).toEqual(["feat/native"]);
    expect(item("feat/native")).toMatchObject({ state: "done", sha });
    expect(existsSync(wt)).toBe(false);
  });

  test("admits independent PRs up to the native GitHub queue's build capacity", () => {
    const first = work("feat/first", 1);
    setFake((s) => { s.nativeQueues = { main: 3 }; });
    expect(run().merged).toEqual([]);
    const second = work("feat/second", 2);
    const third = work("feat/third", 3);
    work("feat/fourth", 4);

    expect(run("--dry-run").waiting.map((x: { branch: string; step: { act: string } }) => [x.branch, x.step.act]))
      .toEqual([["feat/first", "wait"], ["feat/second", "enqueue"], ["feat/third", "enqueue"], ["feat/fourth", "wait"]]);
    expect(json(hwt(["mq", "next"], t1))).toMatchObject({
      busy: { branch: "feat/first" },
      next: { branch: "feat/second", plan: { act: "enqueue" } },
    });
    expect(item("feat/second").state).toBe("queued");
    expect(fake().calls.filter((c) => c.cmd === "gh enqueuePullRequest")).toEqual([]);

    expect(run().merged).toEqual([]);
    expect(run().waiting.map((x: { state: string }) => x.state)).toEqual(["merging", "merging", "merging", "queued"]);
    expect(fake().calls.filter((c) => c.cmd === "gh pr merge")).toHaveLength(1);
    expect(fake().calls.filter((c) => c.cmd === "gh enqueuePullRequest").map((c) => c.arg)).toEqual([
      { n: "2", head: originBranch("feat/second").out.trim() },
      { n: "3", head: originBranch("feat/third").out.trim() },
    ]);
    expect([first, second, third].every(existsSync)).toBe(true);
  });

  test("dry-run reserves capacity for the initial native queue submission", () => {
    work("feat/first", 1);
    work("feat/second", 2);
    setFake((s) => { s.nativeQueues = { main: 1 }; });

    expect(run("--dry-run").waiting.map((x: { step: { act: string } }) => x.step.act)).toEqual(["merge", "wait"]);
    expect(fake().calls.filter((c) => c.cmd === "gh pr merge" || c.cmd === "gh enqueuePullRequest")).toEqual([]);
    expect(run().waiting.map((x: { state: string }) => x.state)).toEqual(["merging", "queued"]);
  });

  test("checks later native queues while the first GitHub entry is pending", () => {
    expect(sh(["git", "push", "-q", "origin", "main:release"]).code).toBe(0);
    const first = work("feat/first", 1);
    const second = work("feat/release", 2);
    setFake((s) => {
      s.nativeQueues = { main: 1, release: 1 };
      s.prs![2]!.base = "release";
    });

    expect(run().waiting.map((x: { state: string }) => x.state)).toEqual(["merging", "merging"]);
    const sha = completeNativeMerge(2, "feat/release");
    const settled = run();
    expect(settled.merged).toEqual(["feat/release"]);
    expect(item("feat/release")).toMatchObject({ state: "done", sha });
    expect(settled.waiting).toMatchObject([{ branch: "feat/first", state: "merging", step: { act: "wait" } }]);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
  });

  test("handles approvals and CI failures during a GitHub wait while keeping current dependencies", () => {
    work("feat/root", 1);
    expect(run().merged).toEqual(["feat/root"]);
    work("feat/root", 2, "root-next");
    const dependent = work("feat/dependent", 3);
    expect(hwt(["mq", "add", "--pr", "3", "--after", "feat/root"], { cwd: dependent }).code).toBe(0);
    work("feat/approval", 4);
    hwt(["note", "--branch", "feat/approval", "review first"], t1);
    const failing = work("feat/failing", 5);
    setFake((s) => { s.nativeQueues = { main: 5 }; });
    checks(5, "fail");

    const result = run();
    expect(result.merged).toEqual([]);
    expect(result.waiting.find((x: { branch: string }) => x.branch === "feat/dependent"))
      .toMatchObject({ state: "queued", step: { act: "blocked", why: "after feat/root" } });
    expect(item("feat/root").state).toBe("merging");
    expect(item("feat/approval")).toMatchObject({ state: "waiting_user", why: "note: review first" });
    expect(hwt(["inbox"], t1).out).toContain("[merge approval]");
    expect(item("feat/failing")).toMatchObject({ state: "returned", why: "CI failed: ci" });
    expect(existsSync(failing)).toBe(true);
    expect(fake().calls.filter((c) => c.cmd === "gh enqueuePullRequest")).toEqual([]);
  });

  test("holds back additional queue admissions when hooks, uncertain status, or changed heads require a wait", () => {
    work("feat/first", 1);
    work("feat/second", 2);
    setFake((s) => { s.nativeQueues = { main: 2 }; });
    const configPath = join(repo, ".hwt.json");
    const original = readFileSync(configPath, "utf8");
    const expectSecondWaits = () => {
      expect(run().waiting.find((x: { branch: string }) => x.branch === "feat/second"))
        .toMatchObject({ state: "queued", step: { act: "wait" } });
      expect(fake().calls.filter((c) => c.cmd === "gh enqueuePullRequest")).toEqual([]);
    };

    writeFileSync(configPath, JSON.stringify({ mainSession: true, mergeQueue: { verify: "true" } }));
    expectSecondWaits();
    writeFileSync(configPath, JSON.stringify({ mainSession: true, mergeQueue: { gc: "true" } }));
    expectSecondWaits();
    writeFileSync(configPath, original);
    setFake((s) => { s.prs![1]!.queueReadError = true; });
    expectSecondWaits();
    setFake((s) => {
      delete s.prs![1]!.mergeQueue;
      delete s.prs![1]!.queueReadError;
      s.prs![1]!.autoMerge = true;
    });
    expectSecondWaits();
    setFake((s) => {
      delete s.prs![1]!.autoMerge;
      s.prs![1]!.mergeQueue = "queued";
      s.prs![2]!.head = "feat/first";
    });
    expectSecondWaits();

    setFake((s) => { s.prs![2]!.head = "feat/second"; });
    expect(run().waiting.map((x: { state: string }) => x.state)).toEqual(["merging", "merging"]);
    expect(fake().calls.filter((c) => c.cmd === "gh enqueuePullRequest")).toHaveLength(1);
  });

  test("a merge request keeps a unique ID when the generated ID collides", () => {
    const wt = work("feat/collision", 1);
    const fixedId = join(dir, "fixed-id.ts");
    writeFileSync(fixedId, "Date.now = () => 1000000; Math.random = () => 0.5;\n");
    const enqueue = () => json(sh([process.execPath, "--preload", fixedId, CLI, "mq", "add", "--pr", "1"], wt)).merge;
    const replaced = enqueue();
    const current = enqueue();
    expect(current).not.toBe(replaced);
    expect(json(hwt(["mq", "log", current])).state).toBe("queued");
  });

  test("watch polls and finishes when the only item is in the GitHub queue", () => {
    const wt = work("feat/native", 1);
    setFake((s) => Object.assign(s.prs![1]!, { mergeQueue: "required", mergeAfterPolls: 2 }));

    expect(run("--watch", "--interval", "0", "--timeout", "10").merged).toEqual(["feat/native"]);
    expect(originMain("feat-native").code).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(fake().calls.filter((c) => c.cmd === "gh pr merge")).toHaveLength(1);
  });

  test("resumes auto-merge, keeps the item on a read failure, and returns it after removal", () => {
    const wt = work("feat/native", 1);
    setFake((s) => void (s.prs![1]!.mergeQueue = "required"));
    expect(run().merged).toEqual([]);

    setFake((s) => {
      delete s.prs![1]!.mergeQueue;
      s.prs![1]!.autoMerge = true;
    });
    expect(run().waiting[0]).toMatchObject({ state: "merging", step: { act: "wait" } });
    setFake((s) => void (s.prs![1]!.queueReadError = true));
    expect(run().waiting[0]).toMatchObject({ state: "merging", step: { act: "wait" } });
    expect(fake().calls.filter((c) => c.cmd === "gh pr merge")).toHaveLength(1);

    setFake((s) => Object.assign(s.prs![1]!, { autoMerge: false, queueReadError: false }));
    expect(run().merged).toEqual([]);
    expect(item("feat/native").state).toBe("returned");
    expect(existsSync(wt)).toBe(true);
    expect(originBranch("feat/native").code).toBe(0);
  });

  test("rechecks legacy cleanup before removing a worktree or trusting deployment verification", () => {
    config({ mainSession: true, mergeQueue: { verify: 'printf "%s" "$HWT_MQ_SHA" > verified-sha' } });
    sh(["git", "push", "-q", "origin", "main"]);
    const open = work("feat/open", 1);
    const merged = work("feat/merged", 2);
    for (const branch of ["feat/open", "feat/merged"]) {
      expect(hwt(["mq", "set", item(branch).id, "cleaning", "--force"], t1).code).toBe(0);
    }
    const sha = completeNativeMerge(2, "feat/merged");

    run();
    expect(item("feat/open").state).toBe("returned");
    expect(existsSync(open)).toBe(true);
    expect(originBranch("feat/open").code).toBe(0);
    expect(item("feat/merged")).toMatchObject({ state: "done", sha });
    expect(existsSync(merged)).toBe(false);
    expect(readFileSync(join(repo, "verified-sha"), "utf8")).toBe(sha);
  });

  test("priority first; the next one is behind, gets updated, waits for CI, then merges", () => {
    const wa = work("feat/a", 1);
    const wb = work("feat/b", 2);
    hwt(["mq", "prio", item("feat/b").id, "5"]);
    const ls = json(hwt(["mq", "ls"]));
    expect(ls.map((m: { branch: string; place: number }) => [m.branch, m.place])).toEqual([["feat/b", 1], ["feat/a", 2]]);
    let r = run();
    // b merges first; a is now behind main: updated, and CI runs again, so this run ends with a waiting.
    expect(r.merged).toEqual(["feat/b"]);
    expect(item("feat/a")).toMatchObject({ state: "updating", updates: 1 });
    expect(r.waiting[0]).toMatchObject({ branch: "feat/a", step: { act: "wait", why: "CI running" } });
    expect(fake().calls.some((c) => c.cmd === "gh pr update-branch")).toBe(true);
    expect(existsSync(wa)).toBe(true);
    expect(existsSync(wb)).toBe(false);
    checks(1, "pass");
    r = run();
    expect(r.merged).toEqual(["feat/a"]);
    expect([originMain("feat-a").code, originMain("feat-b").code]).toEqual([0, 0]);
  });

  test("conflicts and failed CI go back to the worktree's main; a re-add keeps its place", () => {
    const wa = work("feat/a", 1, "same", "a\n");
    work("feat/b", 2, "same", "b\n");
    work("feat/c", 3);
    checks(3, "fail");
    const r = run();
    expect(r.merged).toEqual(["feat/a"]);
    expect(item("feat/b")).toMatchObject({ state: "returned" });
    expect(item("feat/b").why).toContain("conflicts with origin/main");
    expect(item("feat/c").why).toBe("CI failed: ci");
    // Returns are the working sessions' to fix: the main only has them in its log, not in front of it.
    const log = hwt(["inbox", "--log"], t1).out;
    expect(log).toContain("[rebase request]");
    expect(log).toContain("[merge returned]");
    expect(log).toContain("[merge request]");
    expect(log).not.toContain("[base updated]");
    expect(hwt(["inbox"], t1).out).toBe("");
    expect(fake().sent.filter((m) => m.to === "t1")).toEqual([]);
    expect(json(hwt(["status"], t1)).log_recent.at(-1)).toContain("[merge returned]");
    expect(existsSync(wa)).toBe(false);
    // c fixes CI and queues again: it keeps its place in line.
    const seq = item("feat/c").seq;
    checks(3, "pass");
    const again = json(hwt(["mq", "add", "--pr", "3"], { cwd: ledger().worktrees["feat/c"].path }));
    expect(again.place_kept).toBe(true);
    expect(item("feat/c").seq).toBe(seq);
    // a merged meanwhile, so c is brought up to date first and waits for CI again.
    expect(run().merged).toEqual([]);
    expect(item("feat/c").state).toBe("updating");
    checks(3, "pass");
    expect(run().merged).toEqual(["feat/c"]);
  });

  test("approval paths and notes wait for the person; approve lets it through", () => {
    const wt = json(hwt(["new", "feat/db", "--no-space"], t1)).path;
    sh(["mkdir", "-p", "db"], wt);
    writeFileSync(join(wt, "db", "s.sql"), "x\n");
    sh(["git", "add", "."], wt);
    sh(["git", "commit", "-qm", "db"], wt);
    sh(["git", "push", "-q", "-u", "origin", "feat/db"], wt);
    pr(1, "feat/db");
    hwt(["mq", "add", "--pr", "1"], { cwd: wt });
    work("feat/n", 2);
    hwt(["note", "--branch", "feat/n", "hold until Friday"], t1);
    const r = run();
    expect(r.merged).toEqual([]);
    expect(item("feat/db")).toMatchObject({ state: "waiting_user" });
    expect(item("feat/n").why).toBe("note: hold until Friday");
    expect(hwt(["inbox"], t1).out).toContain("[merge approval]");
    // Asked once: a second run doesn't ask again.
    run();
    expect(hwt(["inbox"], t1).out.trim().split("\n").filter((x) => x.includes("[merge approval]"))).toHaveLength(2);
    hwt(["mq", "approve", item("feat/db").id], t1);
    expect(run().merged).toEqual(["feat/db"]);
  });

  test("a failed deploy check: failed, the worktree stays, the log goes back", () => {
    config({ mainSession: true, mergeQueue: { verify: "echo boom; exit 3" } });
    sh(["git", "push", "-q", "origin", "main"]);
    const wt = work("feat/v", 1);
    const r = run();
    expect(r.merged).toEqual(["feat/v"]);
    expect(item("feat/v")).toMatchObject({ state: "failed", why: "deploy check failed (exit 3)" });
    expect(existsSync(wt)).toBe(true);
    // The main's log has one line; the full log is for the working session.
    const log = hwt(["inbox", "--log"], t1).out;
    expect(log).toContain("[deploy failed]");
    expect(log).not.toContain("boom");
    expect(hwt(["inbox"], t1).out).toBe("");
  });

  test("after: waits for another branch; one runner at a time; moves are checked", () => {
    work("feat/a", 1);
    checks(1, "pending");
    const wb = json(hwt(["new", "feat/b", "--no-space"], t1)).path;
    writeFileSync(join(wb, "b"), "b\n");
    sh(["git", "add", "."], wb);
    sh(["git", "commit", "-qm", "b"], wb);
    sh(["git", "push", "-q", "-u", "origin", "feat/b"], wb);
    pr(2, "feat/b");
    hwt(["mq", "add", "--pr", "2", "--after", "feat/a"], { cwd: wb });
    const dry = json(hwt(["mq", "run", "--dry-run"]));
    expect(dry.waiting.map((w: { branch: string; step: { act: string } }) => [w.branch, w.step.act])).toEqual([["feat/a", "wait"], ["feat/b", "blocked"]]);
    expect(dry.events).toEqual([]);
    checks(1, "pass");
    expect(run().merged).toEqual(["feat/a"]);
    expect(item("feat/b")).toMatchObject({ state: "updating" });
    // Another merge lands while b waits: b is updated again, and that shows in its history.
    const wc = work("feat/c", 3);
    void wc;
    expect(run().merged).toEqual(["feat/c"]);
    expect(item("feat/b")).toMatchObject({ state: "updating", updates: 2 });
    expect(item("feat/b").history.filter((h: { to: string }) => h.to === "updating")).toHaveLength(2);
    checks(2, "pass");
    expect(run().merged).toEqual(["feat/b"]);
    // A live runner holds the lease: a second one refuses.
    setFake(() => {});
    const l = ledger();
    l.mq.lease = { holder: "other", pid: process.pid, host: require("node:os").hostname(), since: "now", beat: Date.now() };
    writeFileSync(join(repo, ".git", "hwt", "ledger.json"), JSON.stringify(l));
    const busy = hwt(["mq", "run"], t1);
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("already running (other");
    // done is final; --force is a person's override.
    const id = item("feat/a").id;
    expect(hwt(["mq", "set", id, "queued"]).err).toContain("done → queued is not allowed");
    expect(hwt(["mq", "set", id, "queued", "--force"]).code).toBe(0);
  });

  test("with CI workflows, a PR whose checks haven't shown up yet waits", () => {
    sh(["mkdir", "-p", ".github/workflows"]);
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: push\n");
    sh(["git", "add", "-A"]);
    sh(["git", "commit", "-qm", "ci"]);
    sh(["git", "push", "-q", "origin", "main"]);
    work("feat/n", 1);
    checks(1, "none");
    const r = run();
    expect(r.merged).toEqual([]);
    expect(r.waiting[0]).toMatchObject({ branch: "feat/n", step: { act: "wait", why: "no CI checks reported yet" } });
    // Once CI shows up and passes, it merges.
    checks(1, "pass");
    expect(run().merged).toEqual(["feat/n"]);
  });

  test("a working session can't run the queue", () => {
    const wt = work("feat/w", 1);
    expect(hwt(["mq", "run"], { cwd: wt }).err).toContain("main session's");
  });
});

describe("plain folder (no git)", () => {
  let plain: string;
  const m1 = { HC_TERMINAL_ID: "m1" };
  const at = (e: Record<string, string> = {}, cwd = plain) => ({ cwd, env: { ...e } });
  const stateRoot = () => join(dir, "state", "hwt", "projects");
  const ledgerOf = () => {
    const [d] = require("node:fs").readdirSync(stateRoot()) as string[];
    return JSON.parse(readFileSync(join(stateRoot(), d!, "ledger.json"), "utf8"));
  };

  beforeEach(() => {
    plain = join(dir, "plain");
    sh(["mkdir", "-p", join(plain, "sub")], dir);
    env.XDG_STATE_HOME = join(dir, "state");
    const s = fake();
    s.terminals.push({ address: "m1", name: null, agent: "claude-code", status: "done", state: "live", cwd: plain, labels: {}, parent: null, created_ms: 1 });
    writeFileSync(env.HWT_FAKE_STATE!, JSON.stringify(s));
  });

  test("a child opens in the folder with its name and project; tell, send, status, rm", () => {
    const o = json(hwt(["new", "docs", "--task", "write the docs", "--title", "Docs"], at(m1)));
    expect(o).toMatchObject({ path: plain, branch: "docs", kind: "folder", owner: "m1", terminal: "t100", name: "docs" });
    const call = fake().calls.find((c) => c.cmd === "space.new")!;
    const argv = call.arg.argv as string[];
    expect(call.arg).toMatchObject({ folder: plain, name: "Docs", tab: "docs" });
    expect(argv.slice(0, 4)).toEqual(["env", `HWT_PROJECT=${plain}`, "HWT_CHILD=docs", "claude"]);
    expect(argv.at(-1)).toContain('child session "docs"');
    // The ledger lives outside the folder; the maker became a main.
    expect(existsSync(join(plain, ".git"))).toBe(false);
    expect(ledgerOf().worktrees.docs).toMatchObject({ kind: "folder", owner: "m1", space: "sp100", terminal: "t100" });
    expect(Object.keys(ledgerOf().mains)).toEqual(["m1"]);
    // The child, in the same folder, reaches its main; it can't make children of its own.
    const child = at({ HC_TERMINAL_ID: "t100", HWT_CHILD: "docs", HWT_PROJECT: plain });
    expect(json(hwt(["tell", "[done] README"], child))).toMatchObject({ main: "m1", owner: "m1", delivered: true });
    expect(fake().sent.at(-1)!.text).toStartWith("[done] README — docs: Docs");
    expect(hwt(["inbox"], at(m1)).out).toContain("[done] README");
    expect(hwt(["new", "more", "--agent", "none"], child).err).toContain("main session");
    expect(hwt(["inbox"], child).code).toBe(1);
    // Found by its terminal even without HWT_CHILD/HWT_PROJECT (say a shell that dropped them), in its folder.
    expect(json(hwt(["tell", "x"], at({ HC_TERMINAL_ID: "t100" })))).toMatchObject({ owner: "m1" });
    expect(json(hwt(["send", "docs", "next part"], at(m1)))).toMatchObject({ worktree: "docs", terminal: "t100" });
    const st = json(hwt(["status"], at(m1)));
    expect(st.worktrees).toHaveLength(1);
    expect(st.worktrees[0]).toMatchObject({ branch: "docs", kind: "folder", mine: true, terminals: [{ address: "t100" }] });
    // rm closes its space and terminal only; the folder (and the main's terminal there) stay.
    expect(hwt(["rm", "docs"], at(m1)).err).toContain("agent is live");
    expect(json(hwt(["rm", "docs", "--kill-agents"], at(m1)))).toMatchObject({ spaces_closed: 1, terminals_killed: 1 });
    expect(hwt(["rm", "docs", "--kill-agents"], at(m1)).err).toContain("already removed");
    expect(existsSync(plain)).toBe(true);
    expect(fake().terminals.find((t) => t.address === "m1")!.state).toBe("live");
    expect(ledgerOf().worktrees.docs.state).toBe("removed");
  });

  test("--dir, a promoted folder child, and what needs git", () => {
    const o = json(hwt(["new", "api", "--dir", "sub", "--agent", "none"], at(m1)));
    expect(o.path).toBe(join(plain, "sub"));
    const argv = fake().calls[0]!.arg.argv as string[];
    expect(argv.slice(3)).toEqual(["sh", "-c", 'exec "${SHELL:-/bin/sh}" -l']);
    expect(hwt(["new", "api"], at(m1)).err).toContain("child api exists");
    expect(hwt(["new", "x", "--no-space"], at(m1)).err).toContain("plain folder");
    expect(hwt(["mq", "ls"], at(m1)).err).toContain("needs a git repository");
    // The child becomes a main of its own and makes its own children.
    const child = at({ HC_TERMINAL_ID: "t100", HWT_CHILD: "api", HWT_PROJECT: plain }, join(plain, "sub"));
    expect(json(hwt(["claim"], child))).toMatchObject({ id: "t100", promoted_from: "m1" });
    expect(ledgerOf().worktrees.api).toMatchObject({ self_main: true, owner: "t100" });
    expect(json(hwt(["new", "api-tests", "--agent", "none"], child))).toMatchObject({ owner: "t100", path: plain });
    expect(hwt(["inbox", "--log"], at(m1)).out).toContain("[now a main] sub (api)");
  });

  test("hook: silent in an unconfigured folder (no ledger left behind); a child gets its briefing", () => {
    expect(hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: plain, session_id: "s1" }) }).out).toBe("");
    expect(existsSync(stateRoot())).toBe(false);
    hwt(["new", "docs", "--agent", "none"], at(m1));
    const w = hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: plain, session_id: "c1" }), env: { HWT_CHILD: "docs", HWT_PROJECT: plain } });
    expect(w.out).toContain("working session of plain (worktree docs");
    expect(w.out).toContain('child session "docs"');
    // With a .hwt.json, sessions in the folder are mains.
    writeFileSync(join(plain, ".hwt.json"), JSON.stringify({ mainSession: true }));
    const m = hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: join(plain, "sub"), session_id: "s2" }) });
    expect(m.out).toContain("main session of plain");
  });
});

describe("tools", () => {
  test("init guesses setup from the lockfile", () => {
    writeFileSync(join(repo, "package.json"), "{}");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "");
    const r = json(hwt(["init", "--main-session", "--lang", "ko"]));
    expect(r.config).toMatchObject({ version: 1, setup: "pnpm install", mainSession: true, lang: "ko" });
    expect(hwt(["init"]).code).toBe(1);
  });

  test("init: a JS lockfile without package.json doesn't count; each ecosystem gets its setup; the guess is shown", () => {
    writeFileSync(join(repo, "package-lock.json"), '{"packages": {}}');
    writeFileSync(join(repo, "go.sum"), "");
    let r = hwt(["init"]);
    expect(json(r).config.setup).toBe("go mod download");
    expect(r.err).toContain("setup: go mod download (from go.sum)");
    writeFileSync(join(repo, "package.json"), "{}");
    r = hwt(["init", "--force"]);
    expect(json(r).config.setup).toBe("npm ci && go mod download");
    expect(hwt(["init", "--force", "--setup", "make"]).err).not.toContain("from");
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
    // With a session id, each session in the main checkout is claimed as a main of its own.
    for (const id of ["s1", "s2"]) hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: repo, session_id: id }) });
    expect(Object.keys(ledger().mains)).toEqual(["s1", "s2"]);
    const s2 = hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: repo, session_id: "s2" }) });
    expect(s2.out).toContain('"me":"s2","other_mains":1');
    // feat/h has no owner, so every main sees it.
    expect(s2.out).toContain('"branch":"feat/h"');
    // A worktree session that claimed itself a main starts as a main again.
    hwt(["claim"], { cwd: wt, env: { CLAUDE_CODE_SESSION_ID: "w1" } });
    const p = hwt(["hook", "session-start"], { stdin: JSON.stringify({ cwd: wt, session_id: "w1" }) });
    expect(p.out).toContain("main session of repo (worktree feat-h)");
  });

  test("shell-init prints a wrapper", () => {
    expect(hwt(["shell-init", "bash"]).out).toContain("command hwt");
    expect(hwt(["shell-init", "fish"]).out).toContain("function hwt");
  });
});

describe("install / uninstall", () => {
  const claude = () => join(dir, ".claude");
  const settings = () => JSON.parse(readFileSync(join(claude(), "settings.json"), "utf8"));
  const sessionStart = () => settings().hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));

  test("claude: skill + hook, idempotent, keeps other settings, replaces the old script hook", () => {
    sh(["mkdir", "-p", claude()]);
    writeFileSync(
      join(claude(), "settings.json"),
      JSON.stringify({
        model: "opus",
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "~/.claude/skills/herdr-worktree/scripts/hwt-session-start", timeout: 20 }] }],
          Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
        },
      }),
    );
    const r = json(hwt(["install", "claude", "--lang", "ko"]));
    expect(r.actions.map((x: { change: string }) => x.change)).toEqual(["create", "update"]);
    expect(r.actions[1].note).toContain("replaced the old hook");
    expect(readFileSync(join(claude(), "skills", "hwt", "SKILL.md"), "utf8")).toContain("name: hwt\ndescription: git 워크트리를");
    expect(sessionStart()).toEqual(["hwt hook session-start"]);
    expect(settings().model).toBe("opus");
    expect(settings().hooks.Stop[0].hooks[0].command).toBe("say done");
    expect(existsSync(join(claude(), "settings.json.hwt-backup"))).toBe(true);
    const again = json(hwt(["install", "claude", "--lang", "ko"]));
    expect(again.actions.map((x: { change: string }) => x.change)).toEqual(["unchanged", "unchanged"]);
    // switching language rewrites only the skill
    expect(json(hwt(["install", "claude", "--lang", "en"])).actions.map((x: { change: string }) => x.change)).toEqual(["update", "unchanged"]);
    const doc = json(hwt(["doctor"])).checks.find((c: { name: string }) => c.name === "claude integration");
    expect(doc.ok).toBe(true);
    const u = json(hwt(["uninstall", "claude"]));
    expect(u.actions.map((x: { change: string }) => x.change)).toEqual(["remove", "remove"]);
    expect(existsSync(join(claude(), "skills", "hwt"))).toBe(false);
    expect(settings().hooks.SessionStart).toBeUndefined();
    expect(settings().hooks.Stop).toHaveLength(1);
  });

  test("claude: --dry-run changes nothing; a broken settings.json is left alone", () => {
    const r = json(hwt(["install", "claude", "--dry-run"]));
    expect(r.actions.map((x: { change: string }) => x.change)).toEqual(["create", "create"]);
    expect(existsSync(claude())).toBe(false);
    sh(["mkdir", "-p", claude()]);
    writeFileSync(join(claude(), "settings.json"), "{ not json");
    const bad = hwt(["install", "claude"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("won't overwrite");
    expect(readFileSync(join(claude(), "settings.json"), "utf8")).toBe("{ not json");
  });

  test("codex: skill + marked AGENTS.md block, kept apart from the person's own text", () => {
    const codex = join(dir, ".codex");
    sh(["mkdir", "-p", codex]);
    writeFileSync(join(codex, "AGENTS.md"), "# My rules\n\n- be brief\n");
    const r = json(hwt(["install", "codex", "--lang", "ko"]));
    expect(r.actions.map((x: { change: string }) => x.change)).toEqual(["create", "update"]);
    let md = readFileSync(join(codex, "AGENTS.md"), "utf8");
    expect(md).toStartWith("# My rules\n\n- be brief\n\n<!-- hwt:begin");
    expect(md).toContain("hwt hook session-start");
    expect(json(hwt(["install", "codex", "--lang", "ko"])).actions.map((x: { change: string }) => x.change)).toEqual(["unchanged", "unchanged"]);
    hwt(["install", "codex", "--lang", "en"]);
    md = readFileSync(join(codex, "AGENTS.md"), "utf8");
    expect(md.match(/hwt:begin/g)).toHaveLength(1);
    expect(md).toContain("Make and remove worktrees only with");
    hwt(["uninstall", "codex"]);
    expect(readFileSync(join(codex, "AGENTS.md"), "utf8")).toBe("# My rules\n\n- be brief\n");
    expect(existsSync(join(codex, "skills", "hwt"))).toBe(false);
  });

  test("uninstall leaves a skill that isn't hwt's", () => {
    const d = join(dir, ".claude", "skills", "hwt");
    sh(["mkdir", "-p", d]);
    writeFileSync(join(d, "SKILL.md"), "---\nname: something-else\n---\n");
    const u = json(hwt(["uninstall", "claude"]));
    expect(u.actions[0]).toMatchObject({ change: "unchanged" });
    expect(existsSync(join(d, "SKILL.md"))).toBe(true);
  });
});
