---
name: hwt
description: git 워크트리를 만들거나 지울 때, 그리고 메인 세션 작업 방식(태스크 목록·작업 세션 위임·편지함·머지 큐)으로 일할 때 사용한다. 브랜치를 분리해 병렬로 작업하거나, 다른 에이전트에게 격리된 체크아웃에서 작업을 맡기거나, 사용자가 워크트리를 요청하거나, 새 작업(태스크)을 받거나 "등록된 작업"을 물으면 `git worktree add`·EnterWorktree·레포 안 작업 목록 문서 대신 hwt 를 쓴다.
---

# hwt: Herdr 스페이스로 여는 git 워크트리

`hwt` 는 PATH 에 있다(`brew install yun-sangho/tap/hwt`). stdout 은 JSON, 진행 메시지는 stderr. 점검은 `hwt doctor`.

## 규칙

- 워크트리가 필요하면 항상 hwt를 쓴다. `git worktree add`, EnterWorktree, `.claude/worktrees/` 경로를 직접 쓰지 않는다.
- 레포 안(어느 체크아웃이든)에서 실행한다. 다른 레포면 `cd <repo> && hwt ...`.
- 체크아웃 위치: `<워크트리 루트>/<repo>/<branch에서 / 등을 -로 바꾼 이름>`(Herdr 의 New worktree 와 같은 규칙, 기본 `~/.herdr/worktrees`). 브랜치가 있으면 그 브랜치를 체크아웃하고, 없으면 현재 HEAD에서 새로 만든다.
- 출력: stdout에 JSON, 진행 메시지는 stderr. Herdr가 꺼져 있으면 거부한다(워크트리만 원하면 `--no-space`).
- 에이전트는 `herdr-app do space.new`로 띄운다. Herdr가 사용자의 로그인 셸로 감싸 실행하므로 PATH(nvm 등)가 잡힌다. hwt는 셸을 따로 감싸지 않는다.

## 메인 세션 작업 방식 (`"mainSession": true` 레포)

메인 체크아웃 `.hwt.json`에 `"mainSession": true`가 있는 레포는 아래 방식으로 일한다. 병렬 작업을 시작하는 새 레포도 `.hwt.json`에 `{"mainSession": true}`를 넣어 같은 방식을 쓴다(레포 전용 절차는 그 레포 AGENTS.md 에).

- **메인 세션** = 메인 체크아웃에 뜬 에이전트. 사용자와 대화, 태스크 판단, 워크트리 만들기·지우기, 머지·배포 확인·정리만 한다. 메인 체크아웃 파일을 직접 고치지 않고 구현·조사·테스트는 작업 세션에 맡긴다
- **작업 세션** = 워크트리 하나에서 일하는 독립 에이전트(메인의 자식 아님). 자기 워크트리만 고치고, 워크트리를 만들거나 지우지 않고, 머지하지 않는다
- **상태는 대화가 아니라 장부에**: `<메인 체크아웃>/.git/hwt/`(`ledger.json` 메인·워크트리·세션 ID·태스크·머지 큐·메모, `inbox.jsonl` + `acked` 편지함). 모든 체크아웃이 같이 보고, 커밋되지 않는다
- **작업 목록 = `hwt task`**. 레포 안에 작업 목록 문서(tasks.md 등)를 따로 두지 않는다. "등록된 작업/남은 작업"을 물으면 `hwt task ls --all`·`hwt status` 를 본다

### 메인 세션

```sh
hwt claim                     # 세션 시작 시(SessionStart 훅이 자동으로 한다): 이 터미널을 메인으로 등록
hwt status [--prs]            # 복원용 한 장: notes·tasks·merges·미처리 편지·워크트리별 세션/터미널/PR
hwt note [--branch B] "…"     # 사용자 결정·허락을 받는 즉시 남긴다(예: "PR 나오면 머지까지", 범위 결정). 자동화 안 됨, 습관으로
hwt note --drop <n>           # 잘못 남긴 메모 지우기(n: hwt status 에서 1 = 가장 오래된 것)
hwt inbox [--all] / ack <id>  # 작업 세션 편지. 처리한 id 를 ack (ack --all 은 목록을 다 본 뒤에만)
hwt wait [--timeout S]        # 기다릴 때. hc wait --children 은 쓰지 않는다(옛 메시지로 일찍 끝남)
hwt send <워크트리|브랜치> "…" # 작업 세션에게. 터미널 ID 가 바뀌어도 된다
```

**태스크** — 사용자가 준 일·작업 세션의 `[작업 제안]` 모두 장부에 쌓고 메인이 판단한다.
```sh
hwt task add "<번호> <제목>" --touches path1,path2 [--detail "…"]
hwt task ls [--all]           # 대기·결정·진행 중 + overlaps(같은 경로를 고친 진행 중 브랜치)
hwt task decide <id> now|later|after:<브랜치> --why "…"
hwt new <브랜치> --title "<번호> 짧은 제목" --task "<지시>" --task-id <id>   # running
hwt task done|drop <id> [--why "…"]
```
- `now`(바로 병렬): 겹침 없음, 서로 결과에 기대지 않음
- `after:<브랜치>`: 같은 파일·화면 흐름, 그 PR 에 기댐, 둘 다 DB 스키마·마이그레이션을 바꿈, 공용 규칙 문서를 같이 고침. 그 브랜치가 머지되면 다시 본다
- `later`: 사용자가 순서를 정했거나 범위가 불분명 → 사용자에게 묻고 `note`
- 진행 중 세션의 같은 PR 범위인 작은 후속은 새 태스크로 쪼개지 않고 그 세션에 `send`
- 판단에 코드 조사가 필요하면 메인이 읽지 말고 조사용 작업 세션(읽기 전용 지시)을 띄워 영향 범위·`--touches` 를 보고받는다

**지시(`--task`)에 넣을 것**: 범위, 완료 조건, 검증 명령, "PR 올리고 CI 통과하면 `hwt mq add --pr <n>` 후 머지될 때까지 대기". 보고 방법(`hwt tell`) 안내는 hwt 가 지시 끝에 자동으로 붙인다.

**부르는 이름**: 작업 세션은 늘 "워크트리 이름(작업 제목)" 짝으로 부른다(예: `feat-t14-slot-edit(T14 딜 수정)`). 사용자에게 터미널 ID·세션 ID 로 말하지 않는다. Herdr 로 띄운 터미널은 hc 이름이 없고 레이블 `hwt.worktree=<워크트리 이름>` 을 단다. 작업 세션에게 보낼 때는 `hwt send <워크트리>` 를 쓴다(`hc send <이름>` 은 안 된다). 제목은 Herdr 사이드바가 한글 8자 안팎에서 자르니 짧게, 번호를 앞에.

**머지 큐** — 머지·배포 확인·정리는 메인만, 하나씩.
```sh
hwt mq ls [--all] / mq next   # 항목별 checks: dirty·ahead·behind·conflict·PR/CI·줄 수·approval(auto|user)
hwt mq set <id> merging|verifying|done|returned|failed|waiting_user [--why "…"]
hwt mq approve <id>           # 사용자가 승인함
```
1. `mq next` → 검사 실패(충돌·뒤처짐·CI·dirty)면 `returned` + `hwt send <워크트리> "[리베이스 요청] …"`
2. `note` 에 사용자가 그 PR 에 대해 말한 것이 있으면 따른다. 없으면 `approval: auto` → 메인이 머지, `user`(`.hwt.json` 의 `mergeApproval` 경로·줄 수) → `waiting_user` 로 두고 이유와 함께 사용자에게 묻는다. 메인이 PR 을 읽고 위험하면 `user` 로 올릴 수 있지만 `user` 를 `auto` 로 내리지는 않는다
3. `merging`: `gh pr merge <n>` → `verifying`: 레포의 배포 확인(있으면. 오래 걸리면 `hc run --bg`)
4. 통과 → `done` → `hwt rm <브랜치> -D --kill-agents` + `git push origin --delete <브랜치>` → 레포의 gc(그 레포 AGENTS.md 에 적힌 명령)로 지운 워크트리가 남긴 DB·포트·프로세스 정리 → `after:<브랜치>` 태스크 다시 보기. 실패 → `failed`, 작업 세션에 로그를 넘겨 같은 워크트리에서 고침 PR(다시 `mq add`)
- 작업 세션의 결과를 믿기 전에 PR·CI·커밋을 직접 한 번 확인한다

**재시작한 메인**: `hwt claim` → `hwt status --prs` → notes 를 전제로, `merging`/`verifying` 에서 멈춘 항목 확인, 미처리 편지 처리·ack, 장부엔 `active` 인데 터미널이 없는 세션은 `hwt new <브랜치> --resume-from <session>`(원본 터미널이 살아 있으면 `--fork`). 세션 jsonl 을 복사하지 않는다.

### 작업 세션

```sh
hwt tell "[…] …"              # 메인에게. 편지함에 먼저 적고 살아 있는 메인에게 전달(꺼져 있어도 남는다). hc send 금지
hwt task add "<제목>" --touches … # 일하다 찾은 별도 후속 작업은 직접 하지 말고 제안([작업 제안] 이 같이 간다)
hwt mq add --pr <n> "요약"     # PR + CI 통과 뒤 머지 요청. 머지될 때까지 살아서 returned·failed 에 대응
```
- 메인에 보내는 것: `[워크트리 요청]`·`[작업 제안]`·`[머지 요청]`·`[결정 공유]`(사용자의 답이 다른 작업에도 걸리는 결정)·다른 작업에 영향을 주는 일. 결론만 짧게, 긴 내용은 파일·PR 본문에 쓰고 경로만
- 이 작업 안에서만 필요한 질문(구현 방식·문구·테스트 범위)은 메인을 거치지 않고 자기 화면에서 사용자에게 직접 묻는다
- `hwt new`·`hwt rm` 은 작업 워크트리에서 거부된다(정상). 사람은 `HWT_ANYWHERE=1`

## 만들기 옵션

```sh
hwt new feat/x --title "T3 로그인 수정" --task "<지시>" [--task-id <id>]   # 워크트리 + 스페이스 + 독립 claude 작업 세션
hwt new feat/x --agent codex --task "…"     # codex: --no-daemon -s danger-full-access -a on-request -C <워크트리> 자동
hwt new feat/x --resume-from <세션ID> [--fork]   # 그 세션을 이 워크트리에서 이어(복제해) 띄움
hwt new feat/x --agent none                 # 사람이 볼 셸만
hwt new feat/x --no-space                   # 워크트리만
```
- `--agent claude|codex|none|<명령>`: 기본 `claude`. claude 는 `--session-id` 를 미리 정해 장부에 적는다. task 는 에이전트의 마지막 인자(첫 프롬프트)로 들어간다
- 작업 세션은 늘 독립 에이전트다(부모 없음, keep 켜짐). 예전의 `--name`·`--attach`·`--detach` 는 받기만 하고 무시한다. 내 자식으로 묶은 에이전트가 필요하면 hwt 대신 `hc run` 을 쓴다
- `hwt title <워크트리|브랜치> "…"`: 제목 바꾸기(장부 + Herdr 스페이스·탭)
- 결과 `created: false` 는 기존 워크트리 재사용, `reused_space: true` 는 열린 스페이스로 이동만(새 에이전트 없음 → `hwt send`)

여러 에이전트를 병렬로 돌릴 땐 브랜치마다 워크트리를 하나씩. 한 워크트리에 에이전트 둘을 넣지 않는다.

## 레포 설정 (`.hwt.json`)

체크아웃 자신의 파일 우선, 없으면 메인 체크아웃의 것(`mainSession`·`mergeApproval` 은 메인 체크아웃 것만).
```json
{ "setup": "pnpm install", "mainSession": true,
  "mergeApproval": { "paths": ["db/**", ".github/workflows/**", "AGENTS.md"], "maxLines": 400 } }
```
- `setup`: `new`가 체크아웃을 새로 만들 때만 한 번. 새 스페이스 터미널에서 에이전트보다 먼저 `sh` 로 돈다(`--no-space` 면 호출한 쪽 환경에서 바로). 실패해도 경고만. 건너뛰려면 `--no-hooks`
- teardown 은 없다. `rm` 은 지우기만 한다. 워크트리가 쓰는 자원(DB·포트·dev 서버)은 워크트리가 없어진 뒤에도 레포의 gc 가 찾아 정리할 수 있게 만든다(자원 이름에 슬롯·경로를 붙이고, `git worktree list` 에 없는 것을 지움). 메인 세션이 머지 큐 정리 단계에서 `rm` 뒤에 돌린다. 어떤 방법으로 지웠든(사이드바·`git worktree remove`) 같은 gc 로 정리된다
- `mergeApproval`: 경로에 걸리거나 줄 수를 넘으면 머지에 사용자 승인. 스키마·마이그레이션, 돈·예약 같은 핵심 규칙, 인증, 배포·인프라, 법적 문구, 공용 규칙 문서를 넣는다
- hwt 밖에서 만든 체크아웃(Herdr 사이드바 New worktree·`git worktree add`)에는 setup 이 돌지 않는다. 레포의 스크립트가 필요한 것이 없으면 스스로 준비하게 만든다(예: dev 스크립트가 install 부터)

## 지우기

```sh
hwt rm feat/x [-D] [--kill-agents]   # 스페이스 닫기 + 그 폴더 hc 터미널 종료 + git worktree remove (+ 브랜치 삭제), 장부 removed
hwt ls                                # 이 레포의 워크트리 목록
```
- 살아 있는 에이전트 터미널이 있으면 거부한다. `hc read <id>`로 일하는 중이 아닌지 본 뒤에만 `--kill-agents`
- 커밋 안 한 변경이 있으면 거부한다. `-f`(변경 버림)는 사용자가 명시적으로 허락했을 때만
- `-D`는 브랜치가 머지됐거나 사용자가 허락했을 때만
- 내가 만들지 않은 워크트리(사용자가 연 것, 다른 에이전트 것)는 묻지 않고 지우지 않는다
