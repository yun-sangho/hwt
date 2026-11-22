// Words hwt puts in front of agents and people: the instructions appended to a working session's task,
// message tags, and the session-start briefings. English by default; `"lang": "ko"` in .hwt.json (or
// HWT_LANG / the user config) switches to Korean.
import type { Lang } from "./config.ts";

export interface Messages {
  tags: {
    worktreeRequest: string;
    stopRequest: string;
    taskProposal: string;
    mergeRequest: string;
    decisionShare: string;
    rebaseRequest: string;
  };
  workerInstructions(self: string): string;
  taskProposal(id: string, title: string, touches: string): string;
  mainOnly(main: string, cmd: string, tag: string, sessions: string): string;
  sessionStartMain(repo: string, claimed: boolean): string;
  sessionStartWorker(repo: string, wt: string, branch: string, self: string): string;
}

const en: Messages = {
  tags: {
    worktreeRequest: "[worktree request]",
    stopRequest: "[stop request]",
    taskProposal: "[task proposal]",
    mergeRequest: "[merge request]",
    decisionShare: "[decision]",
    rebaseRequest: "[rebase request]",
  },
  workerInstructions: (self) =>
    `[hwt] Send the main session only what it has to decide, with \`${self} tell "..."\` (never hc send): ` +
    `[worktree request], [task proposal] (\`${self} task add\`), [merge request] (\`${self} mq add --pr <n>\`), ` +
    `and anything that affects other work. Questions that only matter inside this task go straight to the person ` +
    `on this screen, not through the main session. If their answer is a decision other work depends on, tell the main session with [decision].`,
  taskProposal: (id, title, touches) =>
    `[task proposal] ${id} ${title}${touches ? ` (touches: ${touches})` : ""} — please decide with hwt task ls`,
  mainOnly: (main, cmd, tag, sessions) =>
    `hwt ${cmd} runs only from the main session in ${main} (this repo's .hwt.json has mainSession).\n` +
    `Ask it instead: hwt tell "${tag} ..."${sessions ? `  (main sessions now: ${sessions})` : ""}`,
  sessionStartMain: (repo, claimed) =>
    `[hwt] This session is the main session of ${repo}${claimed ? " (claimed: working sessions' hwt tell comes here)" : ""}. ` +
    `Work the hwt way: the task list is hwt task, record the person's decisions and permissions right away with hwt note, ` +
    `hand implementation to working sessions with hwt new, merge one at a time through hwt mq, and run the repo's gc after hwt rm. ` +
    `Below is the ledger (hwt status) in short.`,
  sessionStartWorker: (repo, wt, branch, self) =>
    `[hwt] This session is a working session of ${repo} (worktree ${wt}, branch ${branch}). Change only this worktree; ` +
    `don't create or remove worktrees and don't merge. Reach the main session only with ${self} tell "[…] …" (never hc send): ` +
    `[worktree request], [task proposal] (${self} task add), [merge request] (after the PR's CI passes: ${self} mq add --pr <n>, ` +
    `then stay up until it is merged), [decision]. Questions that only matter inside this task go straight to the person.`,
};

const ko: Messages = {
  tags: {
    worktreeRequest: "[워크트리 요청]",
    stopRequest: "[종료 요청]",
    taskProposal: "[작업 제안]",
    mergeRequest: "[머지 요청]",
    decisionShare: "[결정 공유]",
    rebaseRequest: "[리베이스 요청]",
  },
  workerInstructions: (self) =>
    `[hwt] 메인 세션에는 메인이 판단할 것만 \`${self} tell "..."\` 로 보낸다(hc send 금지): [워크트리 요청]·[작업 제안](\`${self} task add\`)·` +
    `[머지 요청](\`${self} mq add --pr <n>\`)·다른 작업에 영향을 주는 일. 이 작업 안에서만 필요한 질문은 메인을 거치지 않고 이 화면에서 ` +
    `사용자에게 직접 묻는다. 그 답이 다른 작업에도 걸리는 결정이면 [결정 공유] 로 메인에 알린다.`,
  taskProposal: (id, title, touches) =>
    `[작업 제안] ${id} ${title}${touches ? ` (touches: ${touches})` : ""} — hwt task ls 로 판단해 주세요`,
  mainOnly: (main, cmd, tag, sessions) =>
    `hwt ${cmd} 는 ${main} 의 메인 세션에서만 돈다(.hwt.json 의 mainSession).\n` +
    `메인에게 요청한다: hwt tell "${tag} ..."${sessions ? `  (지금 메인 세션: ${sessions})` : ""}`,
  sessionStartMain: (repo, claimed) =>
    `[hwt] 이 세션은 ${repo} 의 메인 세션이다${claimed ? " (hwt claim 완료, 작업 세션의 hwt tell 이 여기로 온다)" : ""}. ` +
    `작업 방식은 hwt 를 따른다: 작업 목록은 hwt task, 사용자 결정·허락은 받는 즉시 hwt note, 구현은 hwt new 로 작업 세션에 맡기고 ` +
    `머지는 hwt mq 로 하나씩, hwt rm 뒤에는 레포의 gc. 아래는 장부(hwt status) 요약이다.`,
  sessionStartWorker: (repo, wt, branch, self) =>
    `[hwt] 이 세션은 ${repo} 의 작업 세션이다(워크트리 ${wt}, 브랜치 ${branch}). 자기 워크트리만 고치고, 워크트리를 만들거나 지우거나 ` +
    `머지하지 않는다. 메인에는 ${self} tell "[…] …" 로만 보낸다(hc send 금지): [워크트리 요청]·[작업 제안](${self} task add)·` +
    `[머지 요청](PR·CI 통과 뒤 ${self} mq add --pr <n>, 머지될 때까지 대기)·[결정 공유]. 이 작업 안에서만 필요한 질문은 사용자에게 직접 묻는다.`,
};

export function messages(lang: Lang): Messages {
  return lang === "ko" ? ko : en;
}

/** How an agent should invoke this hwt: HWT_SELF, the compiled binary, or `bun <cli.ts>` in development. */
export function selfCommand(): string {
  if (process.env.HWT_SELF) return process.env.HWT_SELF;
  const exe = process.execPath;
  if (!/\/bun(-\w+)?$/.test(exe)) return exe;
  const onPath = Bun.which("hwt");
  return onPath ?? `${exe} ${process.argv[1]}`;
}
