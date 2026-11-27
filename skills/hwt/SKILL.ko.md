---
name: hwt
description: git 워크트리를 만들거나 지울 때, 그리고 메인 세션 작업 방식(태스크 목록·작업 세션 위임·편지함·머지 큐)으로 일할 때 사용한다. 브랜치를 분리해 병렬로 작업하거나, 다른 에이전트에게 격리된 체크아웃(git 이 아니면 같은 폴더)에서 작업을 맡기거나, 사용자가 워크트리를 요청하거나, 새 작업(태스크)을 받거나 "등록된 작업"을 물으면 `git worktree add`·EnterWorktree·레포 안 작업 목록 문서 대신 hwt 를 쓴다.
---

# hwt: Herdr 스페이스로 여는 git 워크트리

`hwt` 는 PATH 에 있다(`brew install yun-sangho/tap/hwt`). stdout 은 JSON, 진행 메시지는 stderr. 점검은 `hwt doctor`. 레포(어느 체크아웃이든)나 프로젝트 폴더 안에서 실행한다.

## 규칙

- **git 레포**: 자식 세션마다 자기 워크트리를 받는다. **일반 폴더**(git 아님): `hwt new <이름> --task …` 는 체크아웃 없이 같은 폴더(또는 `--dir <하위 폴더>`)에 Herdr 스페이스를 열어 자식을 띄운다. 폴더 자식들은 파일을 공유하므로 서로 다른 파일이나 하위 폴더를 맡긴다. PR·머지 큐가 없고, 끝나면 `hwt tell` 로 `[완료]` 를 보고한다. 장부는 `~/.local/state/hwt/projects/` 에 있다. 일반 폴더는 `.hwt.json` 이 있을 때만 세션 시작 브리핑을 받는다(`hwt init` 도 거기서 된다)
- git 레포에서 워크트리는 hwt 로만 만들고 지운다. `git worktree add`, EnterWorktree, `.claude/worktrees/` 는 쓰지 않는다.
- 체크아웃 위치: `<워크트리 루트>/<repo>/<브랜치 slug>`(Herdr 의 New worktree 와 같은 규칙, 기본 `~/.herdr/worktrees`). 그래서 Herdr 사이드바에서 레포 아래에 보인다.
- Herdr 가 꺼져 있으면 `hwt new` 는 거부한다. `--no-space` 는 체크아웃만 만든다.

## 메인 세션 작업 방식 (메인 체크아웃 `.hwt.json` 에 `"mainSession": true`)

- **메인 세션은 여러 개이고, 각자 자기 작업 세션을 둔다.** 내가 유일한 메인이라고 가정하지 않는다.
- **메인 세션** = 사용자와 대화하고, 태스크를 판단하고, 워크트리를 만들고 지우고, 머지·배포 확인·정리를 하는 에이전트. 기본적으로 메인 체크아웃의 에이전트 세션은 모두 메인이다(SessionStart 훅이 claim 한다). 자기가 일하는 곳의 파일을 직접 고치지 않고 구현·조사·테스트는 작업 세션에 맡긴다.
- **작업 세션** = 워크트리 하나에서 일하는 독립 에이전트. 만든 메인이 주인이다(장부의 `owner`). 그 메인에게만 보고하고, 자기 워크트리만 고치고, 워크트리를 만들거나 지우지 않고, 머지하지 않는다.
- **작업 세션도 독립 메인이 될 수 있다**: 사용자가 원하면(작업을 더 쪼개야 할 때 등) 자기 워크트리에서 `hwt claim` 한다. 그 워크트리와 PR 을 스스로 맡고, 자기 브랜치에서 갈라진 작업 세션을 `hwt new` 로 만들 수 있다. 원래 메인은 `[메인 독립]` 기록을 받고 더는 관리하지 않는다.
- **메인의 신원**은 에이전트 세션 ID(resume 해도 유지), 없으면 hc 터미널이다. 메인의 터미널에서 새 세션이 시작되면 그 메인의 워크트리·태스크·메모를 넘겨받는다. 아주 사라진 메인의 워크트리는 다른 메인이 `hwt adopt <worktree>` 로 넘겨받는다.
- **내 것**: 내가 만들었거나 넘겨받은 워크트리와 그 태스크·메모·편지함·머지 요청. 주인 없는 기록은 모든 메인의 것이다. 다른 메인의 워크트리에 send·머지·삭제하지 않는다. 사용자에게 묻거나, 허락받고 `adopt` 한다.
- **상태는 대화가 아니라 장부에**: `<메인 체크아웃>/.git/hwt/`(`ledger.json`, `inbox.jsonl`, `acked`). 모든 체크아웃과 모든 메인이 같이 보고, 커밋되지 않는다. hwt 가 `ledger.json` 을 읽을 수 없다고 하면 멈추고 사용자에게 알린다(메시지에 직전 쓰기 전 사본 `ledger.json.bak` 이 나온다). 장부를 지우거나 새로 만들지 않는다.
- **메인은 결정이 필요할 때만 깨운다.** 메인 터미널에 들어가는 것(메인 대화의 한 턴): `[머지 승인 요청]`, `[작업 제안]`, `[선행 완료]`, 작업 세션의 `hwt tell`(`[결정 공유]`, `[워크트리 요청]`). 나머지는 장부의 기록으로만 남고 필요할 때 본다(`hwt inbox --log`, `status.log_recent`): 머지 요청, 반려, 리베이스 요청, 배포 확인 실패, `[메인 독립]`. PR·리뷰·CI 수정·리베이스·다시 줄 서기는 모두 작업 세션 안에서 끝난다.
- **작업 목록 = `hwt task`**. 레포 안에 작업 목록 문서를 따로 두지 않는다. "남은 작업?" → `hwt task ls --all`, `hwt status`(내 것. 모든 메인 것은 `task ls --every-main`).

### 메인 세션

```sh
hwt claim                     # 세션 시작 시(메인 체크아웃에서는 SessionStart 훅이 한다). 다른 메인은 그대로 메인
hwt status [--prs] [--full]   # 한 장 복구: 메인 목록, 내 메모·태스크·안 읽은 메시지, 모든 머지와 워크트리(mine: true = 내 것), PR. 끝난 브랜치의 메모(notes_hidden)와 긴 지시문은 뺀다. --full 은 전부
hwt adopt <worktree>...       # 사라진 메인의 워크트리 넘겨받기(안 읽은 메시지도 같이 온다)
hwt mains [ls]                # 모든 메인: live, owns
hwt mains prune [--release] [--dry-run]   # 사라진 메인 정리. 워크트리를 가진 메인은 --release 없이는 남긴다(주면 그 일은 주인 없음이 된다)
hwt note [--branch B] "…"     # 사용자의 결정·허락은 받는 즉시 기록
hwt note --drop <n>           # 잘못됐거나 더는 맞지 않는 메모 지우기(n: hwt status 의 그 메모 n). status 에 notes_hint 가 나오면 정리한다
hwt inbox [--all] / ack <id>  # 내 결정이 필요한 메시지. 처리한 것은 ack. ack --all 은 이미 내게 보여진 것(inbox·wait·status)만 처리하고 나머지는 먼저 읽으라고 출력한다
hwt inbox --log               # 기록: 결정 없이 일어난 일(머지 요청, 반려, 배포 확인 실패)
hwt wait [--timeout S]        # 기다릴 때(hc wait --children 은 지난 메시지로 일찍 끝나서 쓰지 않는다)
hwt send <worktree> "…"       # 내 작업 세션에게. 지금 터미널 ID 가 뭐든 찾아서 보낸다. 실패하면 다시 보내기 전에 hc read 로 도착했는지 본다
hwt hold <worktree> "<이유>"  # 사용자가 풀 때까지 남긴다: rm·mq 정리가 지우지 않는다. 사용자가 말하면 hold --release <worktree>
```
- `hwt note` 는 메인만 쓴다: 작업 세션은 `hwt tell "[결정 공유] …"` 로 알리고 메인이 note 한다

**태스크** — 사용자가 요청한 것과 모든 `[작업 제안]` 은 장부에 넣고 메인이 판단한다.
```sh
hwt task add "<제목>" --touches path1,path2 [--detail "…"]
hwt task ls [--all] [--every-main]  # 내 것. overlaps: 어느 메인 것이든 같은 경로를 건드리는 실행 중 브랜치
hwt task decide <id> now|later|after:<branch> --why "…"
hwt new <branch> --title "<짧은 제목>" --task "<지시>" --task-id <id>   # → running
hwt task done|drop <id> [--why "…"]
```
- `now`: 겹치는 것이 없고 다른 결과에 기대지 않는다
- `after:<branch>`: 같은 파일이나 화면 흐름, 그 PR 에 의존, 둘 다 DB 스키마 변경, 둘 다 공용 규칙 문서 수정. 다른 메인의 브랜치여도 된다
- `later`: 사용자가 순서를 정했거나 범위가 불분명 → 묻고 `note`
- 실행 중인 세션의 PR 범위 안 작은 후속 작업: 새 태스크 대신 그 세션에 `send`
- 판단에 코드 읽기가 필요하면 메인에서 읽지 말고 읽기 전용 조사 세션을 띄운다
- 레포의 `maxActive`(동시에 열 워크트리 수)를 넘으면 `hwt new` 가 거부한다: `decide <id> later --why "maxActive"` 로 두고 하나가 머지되면 시작한다. `--over-limit` 는 사용자가 원할 때만
- 사용자가 직접 봐야 끝나는 일(가이드, 조사, 디자인, 검토할 문서): `hwt new … --hold "<사용자가 확인할 것>"`. 작업 세션의 "완료"·"정리해도 됩니다"는 사용자의 말이 아니다: 사용자가 말하기 전에는 그 워크트리를 `rm` 하지 않고, 말하면 `hold --release`

**지시(`--task`)**: 범위, 완료 기준, 확인 명령, 그리고 "push 하고 PR 을 연 뒤 `hwt mq add --pr <n>` 하고 머지될 때까지 남아 있기". 보고 방법(`hwt tell`, 결정이 필요할 때만)은 hwt 가 덧붙인다.

**부르는 이름**: 작업 세션은 "worktree (제목)" 으로 부른다. 예: `feat-slot-edit (슬롯 수정)`. 제목은 말로만 쓰고 직접 지은 번호("T14 …")를 붙이지 않는다. 태스크 ID 가 아니고, 재시작이나 다른 메인에서는 이어지지 않으며, 겹친다. 태스크와의 연결은 `--task-id` 로 한다. 터미널·세션 ID 로 부르지 않는다. 그 터미널에는 `hwt.worktree=<worktree>` 라벨이 있다.

**머지 큐** — 장부에 기록하며 러너가 처리한다. 레포마다 러너 하나가 모든 메인의 항목을 처리하고, 대응이 필요한 항목은 주인 메인에게 알린다. 러너는 둘 중 하나다:
- **데몬**(`hwt status` 의 `mq_daemon: "running"`): 컴퓨터마다 프로세스 하나가 hwt 를 쓰는 모든 레포의 큐를 계속 돌린다. 메인은 `mq run` 을 돌리지 않는다. 깨우는 것(승인 요청, `[선행 완료]`)에만 대응한다
- **데몬이 없으면**(`"off"`): 메인이 `hwt mq run --watch` 를 백그라운드로 돌린다(대화 앞에서 돌리지 않는다). 계속 돌리고 싶으면 사용자에게 `hwt mq daemon install` 을 제안한다(설치는 사용자 허락 뒤)
```sh
hwt mq daemon status          # 데몬이 도는지, 마지막 회차, 레포별 열린 항목
hwt mq daemon install [--interval S]   # launchd(macOS)로 로그인할 때 켜고 죽으면 다시 띄운다. uninstall 로 뺀다
hwt mq daemon [--interval S] [--once]  # 터미널에서 직접(macOS 밖에서도)
hwt mq run [--watch] [--interval S] [--timeout S]   # --watch는 CI와 GitHub 큐 상태를 계속 확인한다
hwt mq run --dry-run          # 항목마다 무엇을 할지만 보여 준다. 아무것도 바꾸지 않는다
hwt mq ls [--all] / mq next   # 줄 순서, 주인, blocked_by, 체크. next = 내 다음 항목과 그 계획
hwt mq approve <id>           # 사용자가 승인(waiting_user → queued)
hwt mq prio <id> <n> / mq drop <id> / mq log <id>   # 순서 바꾸기(클수록 먼저), 빼기, 상태 이력
hwt mq set <id> <state> [--force]   # 수동 이동. 허용된 이동만, --force 는 사용자가 덮어쓸 때만
```
- 순서: 우선순위, 그다음 들어온 순서. 반려 뒤 다시 넣은 브랜치는 자리를 유지한다. `mq add --after b1,b2` 는 그 브랜치들이 머지될 때까지 기다린다
- GitHub 큐 대기 중에도 다른 PR의 체크를 확인하고 승인 요청을 보낸다. 조건을 충족한 독립 PR은 대상 큐의 동시 빌드 한도 내에서 제출한다. 진행 중인 PR이 정리된 뒤 직접 머지와 브랜치 갱신을 실행한다. `mergeQueue.verify` 또는 `mergeQueue.gc`를 설정한 레포는 한 건씩 제출한다.
- 러너는 항목마다 한 단계를 정한다: **merge**(CI 통과, 승인 auto 또는 승인됨) → `gh pr merge --squash`(`mergeQueue.method`) → 배포 확인(`mergeQueue.verify`) → 정리: `hwt rm -D --kill-agents`, 원격 브랜치 삭제, 레포 gc(`mergeQueue.gc`), 메인 체크아웃 fast-forward, 태스크 `done`. **update**(베이스보다 뒤처짐, 충돌 없음) → `gh pr update-branch` 후 CI 를 다시 기다린다(`maxUpdates` 까지, 넘으면 반려). **wait**(CI 실행 중) / **blocked**(`after`). **ask**(mergeApproval 경로·줄 수, 그 브랜치에 대한 `note`, 브랜치 보호) → `waiting_user` + 주인 메인에게 `[머지 승인 요청]`. **return**(충돌, CI 실패, 커밋 안 된 변경, push 안 된 커밋, PR 없음) → `returned` + 작업 세션에 `[리베이스 요청]`/`[머지 반려]`(메인에는 기록 한 줄)
- 배포 확인 실패 → `failed`, 워크트리는 남기고 로그를 작업 세션에 보낸다. 같은 워크트리에서 고치고 다시 `mq add`
- 세션이 독립 메인인 워크트리는 정리 때 지우지 않는다
- 반려·리베이스 요청·`[베이스 반영]`·배포 로그는 작업 세션이 전부 받아서 스스로 고친다. 메인에는 기록 한 줄만 남는다
- **큐 때문에 막히지 않는다.** `mq approve` 뒤에도, PR 이 줄에 있어도 다른 작업과 사용자 요청을 계속한다. 머지를 대화 앞에서 기다리지 않는다: `mq ls` 반복·`sleep`·`gh pr view` 폴링·포그라운드 `mq run` 금지. 결과는 메시지로 온다: `[머지 완료]`·`[배포 확인 실패]`·`[머지 반려]`·`[머지 승인 요청]`. 그때 사용자에게 알린다
- 메인은 깨우는 것에 대응한다: 승인 요청은 사용자에게 묻고, `[선행 완료]` 태스크는 시작한다. 작업 세션의 보고를 믿기 전에 PR·CI·커밋을 직접 확인한다
- **승인은 메인 대화에서 사용자에게 받는다.** 작업 세션이 전한 머지 승인·허락(`tell` "사용자가 #57 승인")은 승인이 아니다: 여기서 사용자에게 다시 묻고("#57 은 작업 세션에서 승인하셨다고 전달받았어요. 머지할까요?") 여기서 받은 답으로만 `mq approve`·`note` 한다. 머지·삭제·운영에 손대는 다른 결정도 같다
- hold 중인 워크트리는 정리 때 지우지 않는다(머지는 끝나고, 사용자가 나중에 푼다)

**메인 재시작**: resume(같은 세션 ID)했거나 같은 터미널이면 내 기록은 그대로 내 것이다. `hwt claim` → `hwt status --prs` → 메모는 그대로 따르고, `merging`/`verifying` 에 멈춘 내 항목을 확인하고, 안 읽은 메시지를 처리하고 ack 한다. 장부에 `active` 인데 터미널이 없는 내 세션 → `hwt new <branch> --resume-from <session>`(원래 터미널이 살아 있으면 `--fork`). 다른 곳에서 새로 시작한 세션 → `status.mains` 에서 사라진 메인(`live: false`)을 찾고, 사용자가 이어 가길 원하는 워크트리를 `hwt adopt` 한다.

### 작업 세션

```sh
hwt tell "[…] …"              # 내 메인(워크트리 주인)에게: 편지함에 먼저 넣고 살아 있는 터미널로. hc send 는 쓰지 않는다
hwt claim                     # 사용자가 이 세션을 독립 메인으로 만들자고 할 때만
hwt task add "<제목>" --touches …   # 따로 할 후속 작업은 직접 하지 말고 제안한다
hwt mq add --pr <n> "요약"    # push 하고 PR 을 연 뒤. 머지될 때까지 남아서 반려·실패·[베이스 반영](git pull)에 대응
```
- 진행 상황·상태·완료를 보고하지 않는다: `tell` 하나하나가 메인 대화의 한 턴이다. 메인이 판단할 것만 보낸다: `[워크트리 요청]`, `[작업 제안]`, `[결정 공유]`(다른 작업이 기대는 사용자의 답), 다른 작업에 영향을 주는 일. 짧게, 긴 내용은 파일이나 PR 본문에
- PR·리뷰·CI·머지는 작업 세션 몫이다: `mq add` 가 보고의 전부다. `[리베이스 요청]`·`[머지 반려]`·`[배포 확인 실패]` 가 오면 메인에 알리지 말고 여기서 고쳐 다시 `mq add`
- 이 작업 안에서만 필요한 질문은 내 화면에서 사용자에게 직접 묻는다
- claim 전에는 작업 워크트리에서 `hwt new` / `hwt rm` 이 거부된다(정상). 사용자가 `HWT_ANYWHERE=1` 로 덮어쓸 수 있다

## hwt new

```sh
hwt new feat/x --title "로그인 수정" --task "<지시>" [--task-id <id>]
hwt new feat/x --agent codex --task "…"
hwt new feat/x --resume-from <session id> [--fork]   # 재시작 뒤 에이전트 없이 스페이스만 열려 있어도 된다
hwt new feat/x --agent none        # 셸만
hwt new feat/x --no-space          # 체크아웃만
hwt new docs --task "…" [--dir sub] # 일반 폴더: 체크아웃 없이 이 폴더(또는 sub)에 자식
```
- 새 워크트리는 내 것(`owner`)이다. 그 `hwt tell` 은 나에게만 온다
- 태스크가 에이전트의 첫 프롬프트가 된다. Claude 는 미리 정한 `--session-id` 를 받고 장부에 기록된다
- 작업 세션은 항상 독립 에이전트다(부모 없음). 내 자식 에이전트가 필요하면 `hc run` 을 쓴다
- `created: false` = 기존 체크아웃 재사용. `reused_space: true` = 스페이스가 이미 열려 있었다(새 에이전트 없음 → `hwt send`)
- 워크트리 하나에 에이전트 하나

## .hwt.json

```json
{ "setup": "pnpm install", "mainSession": true, "maxActive": 4,
  "mergeApproval": { "paths": ["db/**", ".github/workflows/**", "AGENTS.md"], "maxLines": 400 },
  "mergeQueue": { "method": "squash", "verify": "scripts/check-deploy", "gc": "make gc", "cleanup": true, "maxUpdates": 3 } }
```
- `setup`: `hwt new` 가 만든 체크아웃에서만 한 번, 새 스페이스 터미널에서 에이전트보다 먼저 돈다(`--no-space` 면 바로). 실패해도 경고만 한다. `--no-hooks` 로 건너뛴다. 다른 방법으로 만든 체크아웃에는 setup 이 없으니 레포 스크립트가 스스로 준비해야 한다
- teardown 은 없다: `rm` 은 지우기만 한다. 체크아웃이 남긴 것은 메인이 `rm` 뒤에 돌리는 레포 gc 가 회수한다
- `mergeApproval`: 경로가 맞거나 줄 수가 넘으면 사용자가 머지를 승인한다
- `maxActive`: 동시에 열어 둘 워크트리 수(이 컴퓨터가 dev 서버·테스트를 나란히 돌릴 수 있는 만큼). 넘으면 `hwt new` 가 거부한다(`--over-limit` 로 넘김)
- `mergeQueue`: `mq run` 의 머지 방식(`method`), 배포 확인(`verify`, 환경 변수 `HWT_MQ_ID/_BRANCH/_PR/_SHA`, `verifyTimeout` 초), 정리(`cleanup`, `gc`), 뒤처진 PR 갱신 최대 횟수(`maxUpdates`), CI 체크가 아직 없는 PR 을 기다릴지(`requireChecks`, 기본: 레포에 .github/workflows 가 있으면), PR 에 베이스가 없을 때의 `base` 브랜치. `batch`(true 또는 숫자): 준비된 PR 을 먼저 모두 머지하고 배포 확인은 한 번만. 뒤처지기만 한 PR 은 갱신 없이 머지한다(GitHub 가 최신 브랜치를 요구하면 갱신). 확인 스크립트는 가장 최근 것을 `HWT_MQ_SHA/_PR/…` 로, 전부를 오래된 순서로 `HWT_MQ_SHAS/_PRS/_IDS/_BRANCHES` 로 받는다. 실패하면 묶음의 PR 이 모두 `failed` 가 되고 주인 메인을 깨운다. 레포의 배포가 마지막 push 의 변경만이 아니라 머지된 커밋 전부를 배포할 때만 켠다
- 메시지 태그는 `lang` 을 따른다. 이 문서는 `"lang": "ko"` 기준이고, 기본(en)이면 `[task proposal]`, `[merge approval]` 처럼 영어로 나온다

## hwt rm

```sh
hwt rm feat/x [-D] [--kill-agents] [--release-hold]
hwt rm docs --kill-agents          # 일반 폴더: 그 자식의 스페이스와 터미널만 닫는다. 파일은 남는다
```
- 체크아웃 안에 에이전트 터미널이 살아 있으면 거부한다: `hc read <id>` 로 일하고 있지 않은지 확인한 뒤 `--kill-agents`
- 커밋 안 된 변경이 있으면 거부한다. `-f`(변경 버리기)는 사용자가 명시적으로 허락했을 때만
- `-D` 는 브랜치가 머지됐거나 사용자가 허락했을 때만
- 작업 세션이 브랜치를 바꿨어도 지금 브랜치 이름으로 찾는다. 체크아웃에 계속 쓰는 프로세스(dev 서버)가 있으면 멈추고 다시 지운다. 손으로 이미 지운 워크트리는 지운 것으로 기록한다
- 그래도 실패하면 메시지가 말하는 것을 고치고 `hwt rm` 을 다시 한다. 워크트리를 손으로 `rm -rf` 하거나 터미널을 `hc kill` 하지 않는다: 장부에 active 로 남는다
- 내가 만들지 않은 워크트리(사용자나 다른 에이전트 것)는 묻지 않고 지우지 않는다
