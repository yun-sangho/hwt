// hwt install / uninstall claude|codex|all: put hwt's skill and session-start wiring where the agents look.
//   Claude Code: <claude dir>/skills/hwt/SKILL.md + a SessionStart hook in <claude dir>/settings.json
//   Codex:       <codex dir>/skills/hwt/SKILL.md + a marked block in <codex dir>/AGENTS.md (Codex has no
//                session-start hook, so the block tells it to run `hwt hook session-start` itself)
// Every write is idempotent; settings.json and AGENTS.md are backed up before they change.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import skillEn from "../../skills/hwt/SKILL.md" with { type: "text" };
import skillKo from "../../skills/hwt/SKILL.ko.md" with { type: "text" };
import { parse } from "../args.ts";
import { langFor, type Lang } from "../config.ts";
import { selfCommand } from "../messages.ts";
import { die, printJson, shQuote } from "../util.ts";

const USAGE = "hwt install|uninstall claude|codex|all [--lang en|ko] [--dry-run]";

export type Change = "create" | "update" | "unchanged" | "remove" | "absent";

export interface Action {
  target: "claude" | "codex";
  what: string;
  path: string;
  change: Change;
  note?: string;
}

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const codexDir = () => process.env.CODEX_HOME || join(homedir(), ".codex");

export const skillText = (lang: Lang) => (lang === "ko" ? skillKo : skillEn);

/** The command the hook runs. Quoted when the path has spaces; `bun <cli.ts>` in development stays two words. */
export function hookCommand(): string {
  const self = selfCommand();
  const cmd = /\s/.test(self) && !/\/bun(-\w+)? /.test(self) ? shQuote(self) : self;
  return `${cmd} hook session-start`;
}

const HOOK_MARK = "hook session-start";
const LEGACY_HOOK = /hwt-session-start/;
const isOurs = (c: unknown) => typeof c === "string" && (c.includes(`hwt ${HOOK_MARK}`) || /\/hwt['"]? hook session-start/.test(c));

function write(path: string, text: string, dry: boolean, backup: boolean): void {
  if (dry) return;
  mkdirSync(dirname(path), { recursive: true });
  if (backup && existsSync(path)) copyFileSync(path, `${path}.hwt-backup`);
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path);
}

function syncFile(target: Action["target"], what: string, path: string, text: string, dry: boolean): Action {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before === text) return { target, what, path, change: "unchanged" };
  write(path, text, dry, false);
  return { target, what, path, change: before === null ? "create" : "update" };
}

/** A skill directory is ours only when its SKILL.md says `name: hwt`. */
function ourSkill(path: string): boolean {
  return existsSync(path) && /^name:\s*hwt\s*$/m.test(readFileSync(path, "utf8"));
}

function removeSkill(target: Action["target"], dir: string, dry: boolean): Action {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return { target, what: "skill", path: file, change: "absent" };
  if (!ourSkill(file)) return { target, what: "skill", path: file, change: "unchanged", note: "not hwt's skill; left alone" };
  if (!dry) rmSync(dir, { recursive: true, force: true });
  return { target, what: "skill", path: file, change: "remove" };
}

// ---- Claude Code ------------------------------------------------------------------------

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Settings;
  } catch (e) {
    die(`can't parse ${path} (${e instanceof Error ? e.message : e}); fix it by hand, hwt won't overwrite it`);
  }
}

/** Ensure exactly one SessionStart hook runs hwt; replace the old herdr-worktree script hook if it is there. */
export function syncClaudeHook(dry: boolean): Action {
  const path = join(claudeDir(), "settings.json");
  const existed = existsSync(path);
  const s = readSettings(path);
  const want = hookCommand();
  const hooks = (s.hooks ??= {});
  const groups = (hooks.SessionStart ??= []);
  let found = false;
  let changed = false;
  let note: string | undefined;
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (isOurs(h.command) || LEGACY_HOOK.test(h.command ?? "")) {
        if (found) {
          h.command = undefined; // a duplicate: dropped below
          changed = true;
          continue;
        }
        found = true;
        if (LEGACY_HOOK.test(h.command ?? "")) note = `replaced the old hook ${h.command}`;
        if (h.command !== want || h.type !== "command") {
          h.type = "command";
          h.command = want;
          h.timeout ??= 20;
          changed = true;
        }
      }
    }
  }
  for (const g of groups) if (g.hooks) g.hooks = g.hooks.filter((h) => h.command !== undefined);
  hooks.SessionStart = groups.filter((g) => (g.hooks?.length ?? 0) > 0 || g.hooks === undefined);
  if (!found) {
    hooks.SessionStart.push({ hooks: [{ type: "command", command: want, timeout: 20 }] });
    changed = true;
  }
  if (!changed) return { target: "claude", what: "SessionStart hook", path, change: "unchanged" };
  write(path, JSON.stringify(s, null, 2) + "\n", dry, true);
  return { target: "claude", what: "SessionStart hook", path, change: existed ? "update" : "create", note };
}

export function removeClaudeHook(dry: boolean): Action {
  const path = join(claudeDir(), "settings.json");
  if (!existsSync(path)) return { target: "claude", what: "SessionStart hook", path, change: "absent" };
  const s = readSettings(path);
  const groups = s.hooks?.SessionStart;
  if (!groups) return { target: "claude", what: "SessionStart hook", path, change: "absent" };
  let removed = false;
  for (const g of groups) {
    const before = g.hooks?.length ?? 0;
    g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h.command));
    if (g.hooks.length !== before) removed = true;
  }
  if (!removed) return { target: "claude", what: "SessionStart hook", path, change: "absent" };
  s.hooks!.SessionStart = groups.filter((g) => (g.hooks?.length ?? 0) > 0);
  if (s.hooks!.SessionStart.length === 0) delete s.hooks!.SessionStart;
  if (Object.keys(s.hooks!).length === 0) delete s.hooks;
  write(path, JSON.stringify(s, null, 2) + "\n", dry, true);
  return { target: "claude", what: "SessionStart hook", path, change: "remove" };
}

/** True when the hook is wired (for doctor). */
export function claudeHookInstalled(): boolean {
  const path = join(claudeDir(), "settings.json");
  if (!existsSync(path)) return false;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Settings;
    return (s.hooks?.SessionStart ?? []).some((g) => (g.hooks ?? []).some((h) => isOurs(h.command) || LEGACY_HOOK.test(h.command ?? "")));
  } catch {
    return false;
  }
}

// ---- Codex --------------------------------------------------------------------------------

const BEGIN = "<!-- hwt:begin (managed by `hwt install codex`; edits here are overwritten) -->";
const END = "<!-- hwt:end -->";

export function codexBlock(lang: Lang): string {
  const self = selfCommand();
  const body =
    lang === "ko"
      ? `## hwt (워크트리·메인 세션 작업 방식)

- 워크트리는 \`hwt\` 로만 만들고 지운다. \`git worktree add\` 를 직접 쓰지 않는다. 사용법 전체는 \`hwt\` 스킬(\`${join(codexDir(), "skills", "hwt", "SKILL.md")}\`).
- git 레포에서 세션을 시작하면 먼저 \`${self} hook session-start\` 를 실행해 이 세션이 메인 세션인지 작업 세션인지, 장부에 무엇이 있는지 확인하고 그 안내를 따른다(출력이 없으면 hwt 작업 방식이 아닌 레포다).
- 작업 세션은 메인에게 \`hwt tell "[…] …"\` 로만 보내고, \`GIT_DIR\` 등으로 메인 체크아웃의 git 상태를 우회해 고치지 않는다(커밋이 막히면 사용자에게 알린다).
- 지울 때 \`-f\`(변경 버림)·\`-D\`(브랜치 삭제)는 사용자 허락 없이 쓰지 않는다.`
      : `## hwt (worktrees and the main-session workflow)

- Make and remove worktrees only with \`hwt\`, never \`git worktree add\`. Full usage: the \`hwt\` skill (\`${join(codexDir(), "skills", "hwt", "SKILL.md")}\`).
- When a session starts in a git repo, first run \`${self} hook session-start\`: it says whether this session is the main session or a working session and what the ledger holds. Follow it (no output: the repo doesn't use the hwt workflow).
- A working session reaches the main only with \`hwt tell "[…] …"\` and never works around the main checkout's git state (\`GIT_DIR\` …); if a commit is blocked, tell the person.
- Don't use \`-f\` (discard changes) or \`-D\` (delete the branch) on removal without the person's permission.`;
  return `${BEGIN}\n${body}\n${END}`;
}

const blockRe = () => new RegExp(`${escape(BEGIN.slice(0, 15))}[\\s\\S]*?${escape(END)}\\n?`);
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function syncCodexBlock(lang: Lang, dry: boolean): Action {
  const path = join(codexDir(), "AGENTS.md");
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const block = codexBlock(lang) + "\n";
  let after: string;
  if (before === null) after = block;
  else if (blockRe().test(before)) after = before.replace(blockRe(), block);
  else after = before.replace(/\n*$/, "\n\n") + block;
  if (after === before) return { target: "codex", what: "AGENTS.md block", path, change: "unchanged" };
  write(path, after, dry, true);
  return { target: "codex", what: "AGENTS.md block", path, change: before === null ? "create" : "update" };
}

export function removeCodexBlock(dry: boolean): Action {
  const path = join(codexDir(), "AGENTS.md");
  if (!existsSync(path)) return { target: "codex", what: "AGENTS.md block", path, change: "absent" };
  const before = readFileSync(path, "utf8");
  if (!blockRe().test(before)) return { target: "codex", what: "AGENTS.md block", path, change: "absent" };
  const after = before.replace(blockRe(), "").replace(/\n{3,}$/, "\n\n").replace(/\n+$/, "\n");
  write(path, after, dry, true);
  return { target: "codex", what: "AGENTS.md block", path, change: "remove" };
}

export function codexBlockInstalled(): boolean {
  const path = join(codexDir(), "AGENTS.md");
  return existsSync(path) && blockRe().test(readFileSync(path, "utf8"));
}

// ---- Commands -----------------------------------------------------------------------------

function targets(t: string | undefined): ("claude" | "codex")[] {
  if (t === "claude" || t === "codex") return [t];
  if (t === "all") return ["claude", "codex"];
  die(`usage: ${USAGE}`);
}

export function cmdInstall(args: string[]): void {
  const a = parse(args, { opts: ["lang"], flags: ["dry-run"] }, USAGE);
  const lang: Lang = a.opt.lang === "ko" || a.opt.lang === "en" ? a.opt.lang : a.opt.lang ? die("--lang is en or ko") : langFor(null);
  const dry = !!a.flag["dry-run"];
  const actions: Action[] = [];
  for (const t of targets(a.pos[0])) {
    if (t === "claude") {
      actions.push(syncFile("claude", "skill", join(claudeDir(), "skills", "hwt", "SKILL.md"), skillText(lang), dry));
      actions.push(syncClaudeHook(dry));
    } else {
      actions.push(syncFile("codex", "skill", join(codexDir(), "skills", "hwt", "SKILL.md"), skillText(lang), dry));
      actions.push(syncCodexBlock(lang, dry));
    }
  }
  printJson({ lang, dry_run: dry, actions }, true);
}

export function cmdUninstall(args: string[]): void {
  const a = parse(args, { flags: ["dry-run"] }, USAGE);
  const dry = !!a.flag["dry-run"];
  const actions: Action[] = [];
  for (const t of targets(a.pos[0])) {
    if (t === "claude") {
      actions.push(removeSkill("claude", join(claudeDir(), "skills", "hwt"), dry));
      actions.push(removeClaudeHook(dry));
    } else {
      actions.push(removeSkill("codex", join(codexDir(), "skills", "hwt"), dry));
      actions.push(removeCodexBlock(dry));
    }
  }
  printJson({ dry_run: dry, actions }, true);
}

export { ourSkill };
