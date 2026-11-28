// Words hwt puts in front of agents and people: the instructions appended to a working session's task,
// message tags, and the session-start briefings. English by default; `"lang": "ko"` in .hwt.json (or
// HWT_LANG / the user config) switches to Korean.
import { realpathSync } from "node:fs";
import type { Lang } from "./config.ts";

export interface Messages {
  tags: {
    worktreeRequest: string;
    stopRequest: string;
    taskProposal: string;
    mergeRequest: string;
    decisionShare: string;
    rebaseRequest: string;
    promoted: string;
    returned: string;
    approval: string;
    baseUpdated: string;
    deployFailed: string;
    unblocked: string;
    merged: string;
    postDeploy: string;
    postDeployProblem: string;
    checkOverdue: string;
  };
  /** To the working session once its PR is deployed: what to check, and how to answer. */
  postDeployCheck(id: string, verify: string[], post: string[]): string;
  /** The criteria the main set at hwt new, appended to the task. */
  verifyInTask(verify: string[]): string;
  /** After the runner merged the base into a PR branch: what the working session does. */
  baseUpdated: string;
  /** After a return: how to get back in line. */
  requeue: string;
  workerInstructions(self: string): string;
  taskProposal(id: string, title: string, touches: string): string;
  mainOnly(main: string, cmd: string, sessions: string): string;
  promoted(wt: string, branch: string): string;
  /** Added to a folder child's task: it shares the folder, and has no PR or merge queue. */
  folderChild(name: string, folder: string): string;
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
    promoted: "[now a main]",
    returned: "[merge returned]",
    approval: "[merge approval]",
    baseUpdated: "[base updated]",
    deployFailed: "[deploy failed]",
    unblocked: "[unblocked]",
    merged: "[merged]",
    postDeploy: "[post-deploy check]",
    postDeployProblem: "[post-deploy problem]",
    checkOverdue: "[check overdue]",
  },
  postDeployCheck: (id, verify, post) =>
    `deployed. Check production now, read-only and with test accounts only:\n` +
    [...verify.map((v) => `- (main's criterion) ${v}`), ...post.map((v) => `- (implementation risk) ${v}`)].join("\n") +
    `\nAll fine: hwt mq release ${id} --result "what you saw, per item" (the queue then cleans up this worktree). ` +
    `Something wrong: hwt mq problem ${id} "what and how" (the worktree stays, the main hears it and decides with the person whether to revert; fixes go in a new PR from here)`,
  verifyInTask: (verify) =>
    `After the deploy, these must hold in production (you check them when the queue sends [post-deploy check]):\n${verify.map((v) => `- ${v}`).join("\n")}`,
  baseUpdated: "the merge queue merged the base into your PR branch; git pull before you commit more. CI runs again, nothing else to do",
  requeue: "Fix it, push, then hwt mq add --pr <n> again (you keep your place in line)",
  workerInstructions: (self) =>
    `[hwt] Don't report progress, status or completion to the main session: every tell is a turn in its conversation. ` +
    `Tell it only what it has to decide, with \`${self} tell "..."\` (never hc send): ` +
    `[worktree request], [task proposal] (\`${self} task add\`), and anything that affects other work. ` +
    `To merge, push, open the PR and right away run \`${self} mq add --pr <n>\` (don't wait for CI: the queue waits for it): that is the whole report. Questions that only matter inside this task go straight to the person ` +
    `on this screen, not through the main session. If their answer is a decision other work depends on, tell the main session with [decision]. ` +
    `After mq add, end your turn: don't wait for or poll CI, the merge or the deploy (no gh pr view/checks loops, no sleep; ${self} wait, ack and inbox are the main session's). ` +
    `The merge queue does all of that and sends you a message only when you have something to do; when merged, it removes this worktree. ` +
    `If your change carries a risk only production shows (a migration, deploy or infra, native server.url, a live integration), add what to check: mq add --post-deploy "…" (repeatable); after the deploy you get [post-deploy check]. ` +
    `If a [rebase request], [merge returned] or [deploy failed] comes back, fix it here and mq add again, without telling the main; ` +
    `on [base updated], git pull before committing more. ` +
    `If the person wants this session to become a main session of its own (to split its work further), run \`${self} claim\` here.`,
  taskProposal: (id, title, touches) =>
    `[task proposal] ${id} ${title}${touches ? ` (touches: ${touches})` : ""} — please decide with hwt task ls`,
  folderChild: (name, folder) =>
    `[hwt] You are child session "${name}" in ${folder}, a plain folder (no git): other sessions work in the same folder, ` +
    `so change only the files your task is about and say in hwt tell which ones you changed. There is no PR or merge queue here; ` +
    `report [done] with hwt tell when finished.`,
  promoted: (wt, branch) =>
    `[now a main] ${wt} (${branch}) is a main session of its own now: it owns this worktree and its PR, and no longer reports to you`,
  mainOnly: (main, cmd, now) =>
    `hwt ${cmd} runs only from a main session: in ${main}, or in a worktree whose session ran hwt claim (this repo's .hwt.json has mainSession).\n` +
    `A working session reports with: hwt tell "[worktree request|task proposal|merge request|decision] ..." ` +
    `(merge: hwt mq add --pr <n> right after opening the PR, then end your turn; the queue messages you if needed)${now ? `  (main session now: ${now})` : ""}`,
  sessionStartMain: (repo, claimed) =>
    `[hwt] This session is a main session of ${repo}${claimed ? " (claimed: the worktrees it makes report here with hwt tell)" : ""}. ` +
    `There can be other main sessions, each with its own working sessions: hwt status, task, inbox and mq next show this one's; ` +
    `take over a gone main's worktrees with hwt adopt. ` +
    `Work the hwt way: the task list is hwt task, record the person's decisions and permissions right away with hwt note, ` +
    `hand implementation to working sessions with hwt new, merge one at a time through hwt mq, and run the repo's gc after hwt rm. ` +
    `Below is the ledger (hwt status) in short.`,
  sessionStartWorker: (repo, wt, branch, self) =>
    `[hwt] This session is a working session of ${repo} (worktree ${wt}, branch ${branch}). Change only this worktree; ` +
    `don't create or remove worktrees and don't merge. Don't report progress or completion to the main session. Reach it only for ` +
    `what it decides, with ${self} tell "[…] …" (never hc send): [worktree request], [task proposal] (${self} task add), [decision]. ` +
    `To merge: push, open the PR, ${self} mq add --pr <n> (that is the report), then end your turn without waiting or polling: what needs fixing comes to you as a message. Questions that only matter inside this task go straight to the person. ` +
    `If the person wants this session to become a main session of its own, run ${self} claim here.`,
};

const ko: Messages = {
  tags: {
    worktreeRequest: "[워크트리 요청]",
    stopRequest: "[종료 요청]",
    taskProposal: "[작업 제안]",
    mergeRequest: "[머지 요청]",
    decisionShare: "[결정 공유]",
    rebaseRequest: "[리베이스 요청]",
    promoted: "[메인 독립]",
    returned: "[머지 반려]",
    approval: "[머지 승인 요청]",
    baseUpdated: "[베이스 반영]",
    deployFailed: "[배포 확인 실패]",
    unblocked: "[선행 완료]",
    merged: "[머지 완료]",
    postDeploy: "[배포 점검]",
    postDeployProblem: "[배포 후 이상]",
    checkOverdue: "[점검 미완료]",
  },
  postDeployCheck: (id, verify, post) =>
    `배포됐다. 지금 운영에서 아래를 점검한다(읽기 전용, 테스트 계정만):\n` +
    [...verify.map((v) => `- (메인 기준) ${v}`), ...post.map((v) => `- (구현 위험) ${v}`)].join("\n") +
    `\n이상 없으면: hwt mq release ${id} --result "항목별로 본 것" (그 뒤 큐가 이 워크트리를 정리한다). ` +
    `이상 있으면: hwt mq problem ${id} "무엇이 어떻게" (워크트리는 남고 메인에 알려진다. revert 는 메인이 사용자와 정하고, 고침은 여기서 새 PR)`,
  verifyInTask: (verify) =>
    `배포 뒤 운영에서 성립해야 할 것(큐가 [배포 점검] 을 보내면 점검한다):\n${verify.map((v) => `- ${v}`).join("\n")}`,
  baseUpdated: "머지 큐가 베이스 브랜치를 PR 브랜치에 반영했다. 더 커밋하기 전에 git pull 한다. CI 는 다시 돌고, 따로 할 일은 없다",
  requeue: "고쳐서 push 한 뒤 hwt mq add --pr <n> 을 다시 한다(줄 순서는 유지된다)",
  workerInstructions: (self) =>
    `[hwt] 메인 세션에 진행 상황·완료를 보고하지 않는다(tell 하나하나가 메인 대화의 한 턴이 된다). ` +
    `메인이 판단할 것만 \`${self} tell "..."\` 로 보낸다(hc send 금지): [워크트리 요청]·[작업 제안](\`${self} task add\`)·다른 작업에 영향을 주는 일. ` +
    `머지는 push 하고 PR 을 열자마자 \`${self} mq add --pr <n>\` 만 하면 된다(CI 를 기다리지 않는다, 큐가 기다린다. 그게 보고 전부다). 이 작업 안에서만 필요한 질문은 메인을 거치지 않고 이 화면에서 ` +
    `사용자에게 직접 묻는다. 그 답이 다른 작업에도 걸리는 결정이면 [결정 공유] 로 메인에 알린다. ` +
    `mq add 뒤에는 턴을 끝낸다. CI·머지·배포를 기다리거나 반복 확인하지 않는다(gh pr view/checks 반복, sleep 금지. ${self} wait·ack·inbox 는 메인 전용). ` +
    `그건 머지 큐가 다 하고, 할 일이 생길 때만 이 세션에 메시지가 온다. 머지되면 이 워크트리는 큐가 정리한다. ` +
    `운영에서만 드러나는 위험(마이그레이션, 배포·인프라, 네이티브 server.url, 운영 연동)이 있는 변경이면 mq add --post-deploy "…"(여러 번 가능)로 점검할 것을 덧붙인다. 배포 뒤 [배포 점검] 이 온다. ` +
    `[리베이스 요청]·[머지 반려]·[배포 확인 실패] 가 오면 메인에 알리지 말고 여기서 고쳐 다시 mq add 한다. [베이스 반영] 이 오면 더 커밋하기 전에 git pull 한다. ` +
    `사용자가 이 세션을 독립된 메인 세션으로 만들자고 하면(작업을 더 나눠 맡기려고) 여기서 \`${self} claim\` 한다.`,
  taskProposal: (id, title, touches) =>
    `[작업 제안] ${id} ${title}${touches ? ` (touches: ${touches})` : ""} — hwt task ls 로 판단해 주세요`,
  folderChild: (name, folder) =>
    `[hwt] 이 세션은 ${folder} 의 자식 세션 "${name}" 이다. git 이 아닌 일반 폴더라 다른 세션도 같은 폴더에서 일한다. ` +
    `맡은 작업의 파일만 고치고, 바꾼 파일을 hwt tell 로 알린다. 여기엔 PR·머지 큐가 없으니 끝나면 hwt tell 로 [완료] 를 보고한다.`,
  promoted: (wt, branch) =>
    `[메인 독립] ${wt} (${branch}) 는 이제 독립된 메인 세션이다: 이 워크트리와 PR 을 스스로 맡고, 더는 이쪽에 보고하지 않는다`,
  mainOnly: (main, cmd, now) =>
    `hwt ${cmd} 는 메인 세션에서만 돈다: ${main}, 또는 세션이 hwt claim 한 워크트리(.hwt.json 의 mainSession).\n` +
    `작업 세션은 hwt tell "[워크트리 요청|작업 제안|머지 요청|결정 공유] ..." 로 보고한다 ` +
    `(머지: PR 을 열자마자 hwt mq add --pr <n> 하고 턴을 끝낸다. 할 일이 생기면 큐가 메시지를 보낸다)${now ? `  (지금 메인 세션: ${now})` : ""}`,
  sessionStartMain: (repo, claimed) =>
    `[hwt] 이 세션은 ${repo} 의 메인 세션 중 하나다${claimed ? " (hwt claim 완료, 이 세션이 만든 워크트리의 hwt tell 이 여기로 온다)" : ""}. ` +
    `메인 세션은 여럿일 수 있고 각자 자기 작업 세션을 둔다: hwt status·task·inbox·mq next 는 이 세션 것만 보여 준다. ` +
    `사라진 메인의 워크트리는 hwt adopt 로 넘겨받는다. ` +
    `작업 방식은 hwt 를 따른다: 작업 목록은 hwt task, 사용자 결정·허락은 받는 즉시 hwt note, 구현은 hwt new 로 작업 세션에 맡기고 ` +
    `머지는 hwt mq 로 하나씩, hwt rm 뒤에는 레포의 gc. 아래는 장부(hwt status) 요약이다.`,
  sessionStartWorker: (repo, wt, branch, self) =>
    `[hwt] 이 세션은 ${repo} 의 작업 세션이다(워크트리 ${wt}, 브랜치 ${branch}). 자기 워크트리만 고치고, 워크트리를 만들거나 지우거나 ` +
    `머지하지 않는다. 메인에 진행 상황·완료를 보고하지 않고, 메인이 판단할 것만 ${self} tell "[…] …" 로 보낸다(hc send 금지): ` +
    `[워크트리 요청]·[작업 제안](${self} task add)·[결정 공유]. 머지는 push·PR 뒤 ${self} mq add --pr <n> 이 보고 전부이고, 그 뒤에는 기다리거나 반복 확인하지 않고 턴을 끝낸다(고칠 것이 생기면 메시지가 온다). 이 작업 안에서만 필요한 질문은 사용자에게 직접 묻는다. ` +
    `사용자가 이 세션을 독립된 메인 세션으로 만들자고 하면 여기서 ${self} claim 한다.`,
};

export function messages(lang: Lang): Messages {
  return lang === "ko" ? ko : en;
}

/**
 * How an agent should invoke this hwt: HWT_SELF, else the `hwt` on PATH when it is this binary (a stable path
 * such as Homebrew's /opt/homebrew/bin/hwt, not the versioned Cellar path an upgrade deletes), else this binary,
 * or `bun <cli.ts>` in development. Agents keep the path in their instructions for as long as they run.
 */
export function selfCommand(): string {
  if (process.env.HWT_SELF) return process.env.HWT_SELF;
  const exe = process.execPath;
  const onPath = Bun.which("hwt");
  if (!/\/bun(-\w+)?$/.test(exe)) {
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    return onPath && real(onPath) === real(exe) ? onPath : exe;
  }
  return onPath ?? `${exe} ${process.argv[1]}`;
}
