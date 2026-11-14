# NexusCode — `nexus` 명령

앱 안의 터미널에는 `nexus` 명령이 있습니다. Claude Code · Codex 같은 에이전트나 사용자가 이 명령으로 앱을 다룹니다. 다른 워크스페이스의 터미널과 에이전트 세션을 보고, 파일과 diff 를 사용자 앞에 열고, 다른 세션에 입력하고 끝나기를 기다리고, 앱의 브라우저를 조작할 수 있습니다.

```bash
nexus help              # 전체 명령
nexus <명령> --help     # 명령별 플래그
nexus status --json     # 모든 명령은 --json 으로 JSON 출력
nexus session list --jsonl   # 목록은 --jsonl 로 한 줄에 하나씩 (grep · jq 용)
```

- 앱 안 터미널(로컬 · SSH 워크스페이스)에서만 동작합니다. 앱 밖의 터미널에서는 `NexusCode is not reachable from this terminal` 이 나옵니다.
- 탭 · 워크스페이스는 id(앞 4자 이상), 이름이나 제목으로 고릅니다. `.` 은 지금 것입니다.
- Windows 에서는 PowerShell · 명령 프롬프트 · Git Bash 어디서든 같습니다. Git Bash 에서는 `/c/...` · `/tmp` 같은 경로도 그대로 쓸 수 있습니다.
- 출력은 영어입니다. 에이전트가 읽는 것을 기준으로 했습니다.

## 둘러보기

| 명령 | 하는 일 |
|---|---|
| `nexus status` | 이 터미널의 위치, 사용자가 보고 있는 화면(에이전트 뷰 · 워크스페이스)과 탭 |
| `nexus workspace list` · `worktree list` · `workspace current` | 워크스페이스와 워크트리 목록, 이 터미널의 워크스페이스 |
| `nexus session list` | 모든 워크스페이스의 에이전트 세션(터미널의 Claude Code, Codex, ... 와 앱의 Claude · Codex 탭)과 상태 |
| `nexus tab list` · `terminal list` | 탭, 터미널과 그 안에서 도는 프로그램 (저장 안 한 편집기는 `(unsaved)`, `--unsaved` 로 그것만) |
| `nexus terminal read <탭>` | 터미널 화면(스크롤백 포함) 읽기 |
| `nexus chat read <탭>` | Claude · Codex 탭의 최근 대화와 상태 |
| `nexus events` | 모든 워크스페이스 에이전트 세션의 상태 변화(번호순). `--since N --wait 10m` 으로 다음 변화를 기다림 |
| `nexus port list` | 이 워크스페이스 터미널에서 실행한 프로그램(개발 서버 등)이 연 포트 (SSH 워크스페이스면 이 컴퓨터에서 열리는 주소도) |
| `nexus device list` | 원격에 로그인한 내 컴퓨터들. 다른 컴퓨터의 세션은 `--device` 로 읽고 조작 |

읽기는 어느 워크스페이스든 허락 없이 됩니다.

## 사용자 앞에 열기

| 명령 | 하는 일 |
|---|---|
| `nexus open src/app.ts:42` | 파일을 그 줄에서 열기 |
| `nexus diff src/app.ts` | 변경 사항 diff 열기 (`--staged`, `--base REF`) |
| `nexus show HEAD~1` | 커밋을 탭으로 열기: 메시지와 바뀐 파일 목록 (sha·브랜치·태그. 기본 HEAD) |
| `nexus terminal new --command "bun dev"` | 새 터미널에서 명령 실행 (기본은 뒤에 열기, `--show` 로 보이기) |
| `nexus terminal new --shell "Git Bash"` | 고른 셸로 터미널 열기 (`nexus terminal shells` 가 이름 목록. 로컬 워크스페이스만) |
| `nexus browser open localhost:3000` | 브라우저 탭 열기 (`/login` 처럼 경로만 주면 이 워크스페이스의 개발 서버 포트로) |
| `nexus port forward 5173` · `port unforward 5173` | SSH 워크스페이스 호스트의 포트를 이 컴퓨터로 포워딩 · 중지 |
| `nexus tab show <탭>` · `workspace switch <이름>` | 그 탭 · 워크스페이스를 사용자에게 보여주기 |
| `nexus settings open keybindings` | 설정 창을 그 페이지로 열어 보여주기 (페이지 이름이나 설정 키. 없으면 마지막 페이지) |
| `nexus manager show` · `manager hide` | 에이전트 매니저 도크 열기 · 닫기 |
| `nexus notify "테스트 통과"` | 데스크톱 알림 |

새로 여는 탭은 명령을 실행한 터미널 위를 덮지 않고 옆 그룹에 열립니다. 그룹이 하나뿐이면 오른쪽으로 나눕니다. 키보드 포커스는 터미널에 그대로 둡니다.

에이전트 뷰가 떠 있을 때는 세션(Claude · Codex 탭, 터미널)을 에이전트 뷰 안에 보여줍니다. 명령을 실행한 세션이 패널에 보이면 그 패널을 덮지 않고 다른 패널에, 패널이 하나뿐이면 오른쪽으로 나눠 엽니다. 그 밖의 탭(파일, diff, 커밋, 브라우저)은 워크스페이스 화면으로 바꿔서 보여주고, 명령을 실행한 세션도 그 워크스페이스에서 앞에 두어 키보드를 이어 씁니다.

## 노트 읽기

| 명령 | 하는 일 |
|---|---|
| `nexus note list` | 이 워크스페이스의 노트 목록 (최신순. id, 제목, 수정 시각, 든 것과 녹음 길이) |
| `nexus note read <노트>` | 노트를 마크다운으로 출력 (id, id 앞부분, 제목으로 지정). 녹음이 있으면 그 원문이 뒤에 붙음 |
| `nexus note path <노트>` | 노트 파일이 든 폴더 (앱이 도는 컴퓨터의 터미널에서만) |

노트는 워크스페이스 폴더가 아니라 앱 데이터 폴더에 워크스페이스 위치별로 보관됩니다. 그림·이미지·파일은 노트 폴더 안의 `sketches/`·`screens/`·`materials/` 상대 경로로, 파일 트리에서 끌어 온 워크스페이스 파일은 `workspace:<경로>` 로 링크됩니다. 로컬 워크스페이스의 터미널에서는 `note read` 끝에 노트 폴더 경로가 함께 나옵니다. SSH·WSL 워크스페이스의 터미널에서는 그 폴더를 열 수 없으므로 `note read` 로 읽습니다. 녹음한 노트의 원문은 녹음마다 `[시각] 화자: 말` 한 줄씩이고, 화자는 사용자가 붙인 이름(없으면 `Speaker 1`)으로 나옵니다. 같은 내용이 노트 폴더의 `transcript.md` 에도 있습니다.

## SSH 워크스페이스의 포트

SSH 워크스페이스의 개발 서버는 원격 호스트에서 돕니다. 앱 브라우저 탭에서 로컬 주소(`localhost:5173`, `127.0.0.1:8080` 등)를 열면, 앱이 그 포트를 워크스페이스의 SSH 연결로 이 컴퓨터에 포워딩하고 거기서 엽니다. 주소창에 쳐도, `nexus browser open` 으로 열어도, Claude 탭의 링크를 눌러도 같습니다.

- 이 컴퓨터의 127.0.0.1 에서만 듣습니다. 같은 포트 번호가 비어 있으면 그 번호를, 아니면 다른 번호를 씁니다. 번호가 다르면 브라우저의 주소도 그 번호로 바뀝니다.
- 원격 호스트 쪽은 그 호스트의 `localhost` 입니다. 127.0.0.1 이나 ::1 에서만 듣는 서버도 닿습니다.
- 앱 밖(시스템 브라우저, 로컬 도구)에서 쓰려면 `nexus port forward 5173` 이나 상태 표시줄 포트 메뉴의 "이 컴퓨터로 포워딩" 으로 미리 포워딩합니다. 메뉴의 "URL 복사" 도 포워딩한 뒤 이 컴퓨터의 주소를 복사합니다.
- 포워딩은 워크스페이스 연결이 끊기면 닫히고, 다시 연결되면 같은 번호로 다시 열립니다. 앱을 다시 켜면 남지 않습니다.
- 멈추려면 `nexus port unforward 5173` 이나 포트 메뉴의 "포워딩 중지". 서버가 멈춘 포트도 포워딩 중이면 메뉴에 남습니다.
- 페이지 안의 링크로 다른 로컬 포트로 가면 그 포트도 포워딩합니다. 페이지가 스크립트로 부르는 다른 포트(API 서버 등)는 따로 포워딩해야 합니다.

## 다른 터미널 · 세션에 입력하고 기다리기

```bash
nexus terminal send codex "테스트 고쳐줘" --wait   # 입력 후 끝날 때까지 기다림
nexus terminal key srv ctrl-c                       # 특수 키
nexus terminal wait srv --match '^ready'           # 화면에 패턴이 나올 때까지
nexus terminal wait build --exit                   # 터미널이 끝날 때까지
```

- 끝났다고 보는 기준:
  - **Claude Code**: 앱 훅으로 정확히 압니다. 마지막 답변까지 출력합니다. `send --wait` 로 넣은 입력이 10초 안에 턴을 시작하지 않으면(일부 슬래시 명령 등) 이전 턴의 답변 대신 "started no turn" 으로 끝납니다(`--json` 의 `state` 는 `notStarted`).
  - **Codex 등 다른 에이전트**: 알림을 보내거나 출력이 `--quiet`(기본 5초) 동안 멈추면 끝난 것으로 봅니다.
  - **일반 셸**: 프롬프트로 돌아오면 끝난 것으로 봅니다.
- 기본 대기 시간은 10분, 최대 30분입니다(`--timeout`). 시간이 다 되면 종료 코드 124 입니다.
- `--match` 는 지금 화면 전체를 봅니다. 입력한 명령 줄 자체가 걸릴 수 있으니 `'^ready'` 처럼 줄 시작에 고정하는 것이 좋습니다.
- 자기 터미널에는 입력할 수 없습니다. 도구 허용을 기다리는 Claude Code 에도 입력하지 않습니다. 허용 여부는 사용자가 정합니다.

## Claude · Codex 탭 열고 따라가기

앱의 Claude 탭과 Codex 탭도 명령으로 열고, 메시지를 보내고, 끝날 때까지 기다립니다. 탭의 입력창에 쓰는 것과 같습니다.

```bash
nexus chat new --prompt "README 요약해줘"                 # 이 폴더에 Claude 탭(뒤쪽에)을 열고 프롬프트 전송
nexus chat new --agent codex --prompt "테스트 고쳐줘" --show
nexus chat wait 3fa2                                     # 턴이 끝날 때까지 기다린 뒤 마지막 답변 출력
nexus chat send 3fa2 "이어서 문서도 고쳐줘" --wait       # 보내고 끝날 때까지
nexus chat read 3fa2 --messages 10                       # 최근 메시지 10개와 상태
nexus chat read 3fa2 --since 41                          # #41 다음부터 전부 (이어 읽기)
nexus chat tool 3fa2 42                                  # #42 도구 호출의 입력과 출력 전체
nexus chat wait 3fa2 9c1e                                # 여러 탭 중 먼저 끝나는 것까지
nexus chat answer 3fa2 deny --message "아직 배포하지 마"  # 기다리는 도구 허용 요청에 답하기
nexus chat interrupt 3fa2                                # 진행 중인 턴 멈추기 (멈춤 버튼과 같음)
nexus chat set 3fa2                                      # 지금 모델 · 추론 강도 · 권한 모드와 고를 수 있는 값
nexus chat set 3fa2 --model sonnet --effort high --mode plan
nexus chat new --agent codex --effort low --mode readOnly --prompt "구조 설명해줘"
nexus chat new --profile 개인 --prompt "README 요약해줘"   # 그 에이전트 프로필(계정)로 연다
```

- 상태는 `working`(일하는 중, 보낸 메시지를 아직 받지 않은 때 포함), `asking`(사용자의 도구 허용 · 질문 답변을 기다림), `idle`, `error` 입니다.
- `chat wait` 는 턴이 끝나거나(마지막 답변 출력), 사용자를 기다리거나, 오류로 멈추면 끝납니다. 기본 대기 시간은 10분, 최대 30분입니다(`--timeout`). 시간이 다 되면 종료 코드 124 입니다.
- `chat send` 는 턴 중이면 에이전트가 지금 도구 다음에 읽습니다. 프로그램이 꺼져 있으면 다시 켜고 보냅니다. 사용자를 기다리는 탭에는 보내지 않습니다. 허용 여부는 사용자가 정합니다.
- `chat read` 는 사용자와 에이전트의 말, 에이전트가 실행한 도구, 앱의 알림(중단, 오류 등)을 순서대로 출력합니다. 기본은 최근 20개, `--all` 이면 전부입니다. 각 항목에는 번호(`#N`)가 붙어, 다음에 `--since N` 으로 그 뒤만 읽습니다. `--subagents` 면 서브에이전트의 도구 호출도, `--max-chars N` 이면 항목마다 N 자까지만 보입니다.
- `chat tool <탭> <번호|id>` 는 도구 호출 하나의 입력(JSON)과 출력을 자르지 않고 보여줍니다.
- `chat wait` 에 탭을 여러 개 주면 먼저 끝나는 탭에서 끝나고, 어느 탭인지 알려줍니다.
- `chat answer <탭> allow|deny` 는 탭이 기다리는 도구 허용 요청에 답합니다. `--message` 는 거절할 때 에이전트에게 전할 이유입니다. 질문 답변과 계획 승인은 사용자만 합니다. 다른 에이전트가 답하려 하면 매번 사용자에게 먼저 묻고, 에이전트 매니저는 아래 설정대로 합니다.
- `chat interrupt` 는 탭의 멈춤 버튼과 같습니다. 대기열의 메시지는 그대로 남습니다.
- `chat set` 은 입력창의 모델 · 강도 · 모드 메뉴와 같고, 다음 턴부터 적용됩니다. 플래그 없이 쓰면 지금 값과 고를 수 있는 모델 · 강도 · 모드를 보여줍니다. 모델은 메뉴에 보이는 값이나 이름, 강도는 그 모델이 받는 값 중 하나입니다. 프로그램이 꺼진 탭은 메시지를 보내 다시 켠 뒤에 바꿉니다. 고른 모델 · 강도는 탭에 남아 앱을 다시 켜도, 포크한 탭에도 이어집니다(Codex 탭은 그 값으로 턴을 보내기 전까지만 남고, 그 뒤로는 스레드가 기억합니다). 권한 모드는 남기지 않습니다.
- `chat new` 의 `--profile` 은 설정 › 에이전트 › Claude · Codex 의 프로필을 이름(대소문자 무시)이나 id 로 고릅니다. 이름을 붙이지 않은 기본 프로필은 `default` 입니다. 주지 않으면 워크스페이스별 프로필 규칙대로 열고, 없는 이름이면 탭을 열지 않고 있는 프로필을 알려줍니다.
- `chat new` 의 `--model` · `--effort` · `--mode` 는 첫 프롬프트를 보내기 전에 적용됩니다. 적용하지 못하면 탭만 열고 프롬프트는 보내지 않은 채 이유를 알려줍니다(종료 코드 1).
- 권한 모드는 Claude 가 `default` · `acceptEdits` · `plan` · `auto`, Codex 가 `readOnly` · `auto` 입니다. 묻지 않고 더 많이 실행하게 바꾸는 모드(예: `plan` → `acceptEdits`)는 매번 사용자에게 확인 창으로 묻고, 에이전트 매니저는 "권한 요청 응답" 설정대로 합니다. 모두 허용하는 모드(`bypassPermissions`, `fullAccess`)는 사용자만 탭에서 고릅니다. 자기 탭의 설정은 바꾸지 않습니다.
- 앱을 켠 뒤 한 번도 보지 않은 탭은 읽거나 기다리거나 보낼 때 열립니다. 탭을 보여줄 때처럼 프로그램의 기록을 읽고, 프로그램이 없으면 켭니다.
- 다른 워크스페이스의 탭은 `--workspace` 로 고릅니다.

## 세션들의 변화 따라가기

`nexus events` 는 모든 워크스페이스의 에이전트 세션(터미널의 Claude Code · Codex 등과 Claude · Codex 탭)이 상태를 바꿀 때마다 남긴 기록입니다. 에이전트 보기가 보여주는 상태와 같습니다.

```bash
nexus events                                 # 최근 변화 (기본 100개)
nexus events --since 57 --wait 10m --jsonl   # #57 다음 변화. 없으면 올 때까지 기다림
nexus events --workspace api --limit 20
```

- 변화는 시작(일을 하며 나타남), 상태 바뀜(working, asking, idle, completed, error, ...), 닫힘이고, 마지막 답변이나 질문이 함께 나옵니다. 자기 세션의 변화에는 `(you)` 가 붙습니다.
- 번호는 앱을 켤 때 1부터 다시 셉니다. 앱은 최근 1000개를 갖고 있고, 최신보다 큰 `--since` 는 처음부터 읽습니다.
- `--wait` 은 최대 30분입니다. 시간이 다 되도록 변화가 없으면 종료 코드 124 입니다. 다시 실행하면 이어서 기다립니다.

## 다른 컴퓨터

같은 NexusCode 계정으로 원격(**설정 → 원격**)에 로그인한 다른 컴퓨터의 세션도 `--device` 로 읽고 조작합니다. 컴퓨터는 id, 4자 이상의 id 앞부분, 또는 이름으로 고릅니다. `--device` 가 없으면 이 컴퓨터입니다.

```bash
nexus device list                                   # 내 컴퓨터들: 이 컴퓨터, 온라인, 오프라인
nexus session list --device "Mac mini"              # 그 컴퓨터의 세션 (--device all 은 모든 컴퓨터)
nexus chat send 1a2b --device "Mac mini" --wait -   # 그 컴퓨터의 탭에 보내고 끝날 때까지 기다림
```

- `session list` 는 이 컴퓨터만 보여주고, 다른 컴퓨터에 일하는 세션이 있으면 끝에 `+ 5 sessions on 1 other computer: nexus session list --device all` 을 덧붙입니다. `--device` 를 주면 DEVICE 열이 생기고, JSON 에는 `device: {id, name}` 이 붙습니다. 오프라인 컴퓨터는 목록을 실패시키지 않고 한 줄로 알립니다.
- 다른 컴퓨터에서는 `--workspace` 를 주지 않으면 그 컴퓨터의 모든 탭에서 찾습니다. `.` 은 이 컴퓨터의 것이라 쓸 수 없습니다.
- 읽기(`session list`, `chat read`, `terminal read`, `wait`, `events`)는 언제나 됩니다. 에이전트가 보내거나 바꾸는 일은 그 컴퓨터의 "다른 컴퓨터의 에이전트" 설정(묻기 · 허용 · 거부)을 따릅니다. 묻기면 그 컴퓨터에 확인 창이 뜨고 90초 안에 답이 없으면 거절됩니다. 사람이 자기 셸에서 실행한 명령은 원격 설정의 채팅 · 터미널 조작 스위치를 따릅니다.
- 받는 쪽 에이전트에게는 보낸 컴퓨터와 탭, 답장할 명령(`nexus chat send ... --device ...`)이 함께 갑니다. 에이전트끼리 주고받은 메시지가 8개를 넘으면 루프로 보고 거절합니다.
- 종료 코드: 오프라인(`"Mac mini" is offline (last seen 12m ago)`), 이 컴퓨터가 원격에 없음, 구버전, 응답 없음은 3, 그 컴퓨터가 거절하면(`"Mac mini" refused: ...`) 1 입니다. `--json` 이면 `{error, device, ...}` 도 출력합니다.
- 서브에이전트(`agent`), 브라우저, 화면 배치 · 에이전트 뷰, `worktree new`, 포트, `problems` 는 이 컴퓨터에서만 됩니다.

## 에이전트 매니저

앱과 함께 켜져 모든 워크스페이스의 세션을 보고 지시하는 에이전트입니다. **설정 → 에이전트 매니저** 에서 켜고, Claude Code 와 Codex 중 무엇으로 돌릴지 고릅니다. 모델과 사용량은 그 에이전트 계정의 것을 그대로 씁니다.

- 제목 표시줄의 **매니저** 버튼으로 오른쪽 도크를 엽니다. 워크스페이스 보기와 에이전트 보기 모두에서 쓸 수 있고, 도크를 닫아도 매니저는 계속 돕니다. 도크가 닫힌 동안 온 보고는 버튼에 숫자로 표시됩니다.
- 매니저는 위의 `nexus` 명령으로 세션을 만들고(`chat new`, `worktree new`), 메시지를 보내고(`chat send`, `terminal send`), 읽고(`chat read`, `terminal read`, `events`) 결과를 사용자에게 알려줍니다. 워크스페이스에 속하지 않아 `--workspace` 를 주지 않으면 사용자가 보고 있는 워크스페이스로 갑니다.
- 매니저가 다른 워크스페이스를 바꿀 때는 묻지 않습니다. 다만 터미널 입력, 명령을 주고 여는 새 터미널, 메시지, 프롬프트를 주고 여는 새 탭 · 작업은 "다른 워크스페이스 변경" 설정을 따릅니다. 매니저가 읽는 세션의 말과 탭 제목에는 무엇이든 들어 있을 수 있기 때문입니다. **매번 묻기**면 매번 확인 창이 뜨고, **허용**이면 묻지 않습니다.
- 매니저가 일을 맡긴 세션은 도크 위의 "맡긴 작업" 목록과 에이전트 보기 사이드바의 **매니저** 표시로 보입니다. 매니저가 보낸 메시지에는 "매니저가 보냄" 이 붙습니다.
- 세션이 끝나거나, 사용자를 기다리거나, 오류로 멈추면 앱이 매니저에게 `[NexusCode]` 로 시작하는 메시지로 알립니다. 가까이 일어난 일은 한 번에 묶어, 매니저가 일하지 않을 때 보냅니다. 무엇을 알릴지는 "매니저에게 알릴 일" 로 고릅니다.
  - **맡긴 작업**: 매니저가 일을 맡긴 세션만
  - **+ 대기·오류**(기본): 거기에 더해 다른 세션이 사용자를 기다리거나 오류로 멈출 때
  - **전부**: 모든 세션이 끝나거나 멈출 때. 많을수록 사용량이 늘어납니다.
- "권한 요청 응답" 은 매니저가 다른 세션의 도구 허용 요청(`chat answer`)에 답해도 되는지 정합니다. **넘기기**(기본)는 사용자만 답하고, **매번 묻기** 는 매니저가 답하기 전에 확인 창을 띄우고, **대신 답하기** 는 묻지 않고 답하게 합니다. 터미널에서 도는 에이전트의 요청은 이 설정과 상관없이 `terminal send` 로만 답할 수 있습니다.
- 앱이 뒤에 있을 때 매니저의 답은 데스크톱 알림으로도 옵니다. **설정 → 알림** 의 "에이전트 매니저 보고" 로 끕니다.
- `nexus manager show` · `manager hide` 로 도크를 열고 닫고, `manager new` 로 도크의 **새 대화** 처럼 새로 시작합니다(매니저 자신은 못 함).
- 도크의 **새 대화** 는 지금 대화를 두고 새로 시작합니다. 매니저의 작업 폴더는 `~/.nexus-code/manager` 이고, 앱을 다시 켜면 이전 대화를 이어갑니다.
- 매니저 설정은 사용자만 설정 창에서 바꿀 수 있습니다(`nexus settings` 에 없음). `nexus settings open manager` 로 그 페이지를 열어 보여줄 수는 있습니다.

## 세션의 에이전트 따라가기

Claude Code 세션 안의 서브에이전트와, 그 세션이 Bash 로 실행한 `claude -p` · `codex exec` 를 봅니다. 세션이 `claude -p` 나 `codex exec` 를 서브에이전트처럼 쓸 때 유용합니다. Codex 탭이 명령으로 실행한 `claude -p` · `codex exec` 도 그 탭의 실행으로 보입니다.

```bash
claude -p "README 요약해줘" > /dev/null &   # Bash 도구에서 백그라운드로 실행
codex exec "테스트 고쳐줘" > /dev/null &
nexus agent list                            # 이 터미널 세션의 서브에이전트 · claude -p · codex exec 실행
nexus agent show 8f7b                       # 상태, 모델, 도구와 결과, 중간 응답, 답변
nexus agent wait 8f7b --timeout 5m          # 끝날 때까지 기다린 뒤 show 처럼 출력
nexus agent stop 8f7b                       # 실행 멈추기
claude -p --resume <세션 id> "이어서 테스트도 추가해줘"   # 같은 실행으로 이어짐
codex exec resume <세션 id> "이어서 문서도"            # codex 도 같은 실행으로 이어짐
```

- 실행의 id 는 그 세션 id 입니다. `claude -p --resume <id>` · `codex exec resume <id>` 로 이어 가면 새 실행이 아니라 같은 실행이 이어지는 것으로 보입니다. `claude -p` 는 미리 id 를 정하려면 `--session-id` 를 줍니다. `codex exec --ephemeral` 실행은 세션을 남기지 않아 id 가 없습니다.
- 다른 API 로 돌린 실행은 그 주소(호스트)를 함께 보여 줍니다: `claude -p` 는 `ANTHROPIC_BASE_URL`, `codex exec` 는 `config.toml` 의 `model_provider` 와 그 `base_url`(또는 `OPENAI_BASE_URL`)에서 읽습니다. 모델은 `ANTHROPIC_MODEL` · `-m` · `-c model=…` 이나 설정에서 읽습니다.
- 서브에이전트와 실행이 도구 사이에 쓴 말(중간 응답)도 도구와 함께 시간순으로 보입니다(최근 20개). 서브에이전트의 중간 응답은 그 트랜스크립트에서 읽으므로, 다음 도구를 부르거나 끝날 때 보입니다.
- `codex exec` 의 도구와 중간 응답은 `--json` 이면 그 출력에서, 아니면 세션 기록(`~/.codex/sessions` 의 rollout 파일)에서 읽습니다. 세션 기록에는 끝난 항목만 적히므로 이때 도구는 끝난 뒤에 걸린 시간과 함께 보입니다. 세션을 남기지 않는 `--ephemeral` 실행과, stderr 를 터미널에 바로 쓰는 실행은 모델 · 답만 보입니다.
- `claude -p` 의 도구와 중간 응답은 실행의 트랜스크립트(또는 `--output-format stream-json` 출력)에서 읽습니다. `-c` 나 검색어로 이어 가는 실행은 어느 세션인지 미리 알 수 없어 도구가 `?` 로 나옵니다.
- 실행을 이어 갈 때는 `-c` 대신 `--resume <id>` 를 씁니다. `-c` 는 그 폴더의 가장 최근 세션을 이어 가는데, 세션 안에서는 그게 호출한 세션 자신입니다.
- `agent wait` 의 기본 대기 시간은 10분, 최대 30분입니다(`--timeout`). 시간이 다 되면 종료 코드 124 입니다.
- `agent stop` 은 그 `claude`(또는 `codex`) 에 인터럽트를 보내고, 5초 안에 멈추지 않으면 종료합니다. 서브에이전트는 세션의 턴과 함께 멈추므로 멈출 수 없습니다.
- 다른 터미널의 세션은 `--tab`(다른 워크스페이스면 `--workspace` 도)으로 고릅니다.
- 앱을 업데이트하기 전부터 돌던 Claude · Codex 탭의 프로그램은 예전 환경 그대로라, 그 탭이 띄운 실행은 탭의 프로그램이 다시 시작된 뒤부터 보입니다.

## 워크스페이스 추가 · 제거

```bash
nexus workspace add ../lib --name 라이브러리 --show   # 이 터미널 위치 기준 폴더를 사이드바 끝에 추가
nexus workspace remove 라이브러리                    # 앱 목록에서 제거(폴더는 그대로)
```

- `workspace add` 는 앱의 **워크스페이스 추가** 와 같습니다.
  - 폴더 이름이 사이드바 이름이 됩니다. `--name` 으로 바꿀 수 있습니다.
  - SSH · WSL 터미널에서 실행하면 그 터미널과 같은 호스트(같은 접속 방법)의 폴더를 추가합니다.
  - 처음 보여줄 때 연결합니다. `--show` 면 바로 그 워크스페이스로 전환합니다.
  - 이미 목록에 있는 폴더면 새로 만들지 않고 그 워크스페이스를 알려줍니다. 묻지 않습니다.
- `workspace remove` 는 사이드바 메뉴의 **목록에서 제거** 와 같습니다.
  - 그 워크스페이스와 작업들의 터미널을 닫고(실행 중인 프로그램 포함) 사이드바에서 뺍니다. 폴더는 지우지 않습니다. 작업의 워크트리 폴더와 브랜치도 디스크에 남습니다.
  - 저장하지 않은 파일이 있거나, 명령을 실행한 터미널이 그 워크스페이스(또는 그 작업) 안에 있으면 거절합니다.
  - 작업 하나만 지우려면 `worktree remove` 를 씁니다.
  - 항상 다른 워크스페이스라서 아래 "다른 워크스페이스 바꾸기" 설정을 따릅니다.

## 작업(워크트리) 만들기 · 지우기

앱의 **작업**(브랜치마다 따로 둔 git 워크트리)을 명령으로 만들고 지웁니다. 에이전트가 일을 나눠 다른 에이전트에게 맡길 때 씁니다.

```bash
nexus worktree new "로그인 수정" --prompt "로그인 후 원래 보던 페이지로 돌아가게 고쳐줘"
nexus chat wait <탭 id> --workspace <작업 id>         # 출력된 명령 그대로. 그 에이전트가 끝날 때까지
nexus worktree new 환불 --agent codex --prompt "환불 API 추가해줘"                  # Codex 탭으로
nexus worktree new 실험 --command "gemini" --prompt "벤치마크 돌려줘"                 # 터미널에서 다른 명령으로
nexus worktree switch 환불                                                          # 사용자 화면을 그 작업으로
nexus worktree remove "로그인 수정" --delete-branch
```

- `worktree new` 는 앱의 **새 작업…** 과 같습니다.
  - 지금 HEAD 에서 이름을 딴 브랜치와 워크트리를 만듭니다. 작업 안에서 실행하면 그 작업이 속한 워크스페이스에서 만듭니다.
  - 작업에 작업 에이전트(설정 › 에이전트, 기본 Claude)의 탭을 열고 `--prompt` 를 첫 메시지로 보냅니다. `--agent claude` · `--agent codex` 로 그 작업만 다른 에이전트를 고릅니다. 작업 에이전트가 "터미널만"이면 셸만 엽니다.
  - `--command` 를 주면 탭 대신 터미널에서 그 명령을 실행합니다. 프롬프트는 명령의 맨 뒤 인자로 붙습니다(`--command "claude --model opus"`, `--command gemini`). `--command ""` 면 에이전트 없이 셸만 엽니다.
  - 그 탭(터미널이면 그 터미널)을 기다리는 명령을 출력합니다. 작업은 다른 워크스페이스라서 `chat` · `terminal` 명령에 `--workspace` 가 필요합니다.
  - 사용자 화면은 그대로 둡니다. `--show` 면 그 작업으로 전환합니다.
- `worktree remove` 는 앱의 **이 작업 삭제…** 와 같습니다.
  - 작업의 터미널을 닫고(실행 중인 프로그램 포함) 워크트리 폴더를 지웁니다. 브랜치는 `--delete-branch` 일 때만 지웁니다.
  - 커밋하지 않은 변경이 있으면 거절합니다. `--force` 면 그 변경을 버리고 지웁니다.
  - 저장하지 않은 파일이 있거나, 명령을 실행한 터미널이 그 작업 안에 있으면 거절합니다.
  - 작업은 그 자체로 다른 워크스페이스라서, 지우기는 항상 아래 "다른 워크스페이스 바꾸기" 설정을 따릅니다.

## 브라우저 조작

앱의 브라우저 탭을 에이전트가 직접 다룹니다. 화면에 안 보이는 탭에서도 동작합니다.

```bash
nexus browser open localhost:5173/login
nexus browser snapshot            # 페이지 구조와 요소 ref (e1, e2, ...)
nexus browser fill e3 me@example.com
nexus browser type " 추가" --into e3  # 있던 글 뒤에 이어 입력 (--into 없으면 포커스된 곳)
nexus browser click e6
nexus browser press Enter
nexus browser hover e4             # 마우스를 올려 둠 (메뉴 · 툴팁)
nexus browser drag e7 e9           # e7 을 e9 위로 끌어다 놓기
nexus browser scroll down          # up · down · left · right · top · bottom · 요소
nexus browser upload e5 photo.png  # 파일 입력에 파일 넣기 ("" 면 비움)
nexus browser dialog accept        # 페이지의 alert · confirm 에 답하기 (dismiss 는 취소)
nexus browser wait --text "Welcome"
nexus browser screenshot --out shot.png
nexus browser screenshot --element e6   # 요소 하나만
nexus browser inspect e6          # 요소의 ref · 선택자 · 위치 · HTML · 스크린샷 (사용자 클릭 없이)
nexus browser console --errors
nexus browser network --failed    # 페이지가 보낸 요청 (실패 · 4xx · 5xx 만)
nexus browser network 12          # 요청 12 의 헤더 · 보낸 내용 · 응답
nexus browser eval "document.title"
nexus browser pick                # 사용자가 클릭한 요소의 ref · 선택자 · 스크린샷
nexus browser back                # 뒤로 (browser forward 로 앞으로, browser reload 로 새로고침)
nexus browser list                # 이 워크스페이스의 브라우저 탭
```

- `browser open /login` · `browser goto /login` 처럼 경로만 주면, 이 워크스페이스(작업이면 그 워크트리) 터미널의 프로그램이 연 포트로 엽니다. 포트를 미리 정해 둘 필요 없이 작업마다 따로 띄운 개발 서버를 찾아갑니다.
  - 열린 포트가 없거나 여러 개면 열지 않고 그 목록을 알려줍니다. 그때는 `localhost:5173/login` 처럼 포트를 적어 주세요.
  - 포트는 `nexus port list` 로 봅니다. 상태 표시줄 오른쪽과 제목 표시줄의 작업 메뉴에도 나옵니다.
  - 49152 이상의 포트, Docker 가 연 포트, 셸을 떠나 데몬으로 도는 서버는 찾지 못합니다.
  - SSH 워크스페이스에서 `localhost` 같은 로컬 주소는 원격 호스트의 것입니다. 열 때 그 포트를 이 컴퓨터로 포워딩해서 엽니다(아래 "SSH 워크스페이스의 포트").
  - 로컬 파일은 `file:///경로` 로 엽니다.
- 요소는 마지막 `snapshot` 의 ref(`e12`)나, 요소 하나만 맞는 CSS 선택자로 고릅니다. 페이지가 다시 로드되면 snapshot 을 새로 찍어야 합니다.
- `inspect` · `pick` 은 React · Vue · Svelte · Angular 앱의 개발 빌드에서 요소가 속한 컴포넌트(바깥 컴포넌트까지), 그 요소를 쓴 소스 파일, 컴포넌트 props 도 알려줍니다.
  - 줄 번호는 React 18 이하(JSX source)와 Svelte 에서만 나옵니다. React 19 는 브라우저가 실행한 파일까지만 알 수 있습니다(Vite 개발 서버면 그 소스 파일, 번들이면 번들 파일).
  - 프로덕션 빌드는 이름이 줄여져 있고 소스 위치가 없습니다.
- 클릭은 실제 마우스 이벤트입니다. 다른 요소가 덮고 있으면 거절합니다(`--force` 로 그 자리를 그냥 클릭).
- `hover` 는 마우스를 요소 위에 올려 두고, 다음 명령까지 그대로 둡니다. 열린 메뉴나 툴팁을 `snapshot` · `screenshot` 으로 볼 수 있습니다.
- `drag <요소> <놓을 곳>` 은 실제 마우스로 누르고, 옮기고, 놓습니다. HTML 드래그 앤 드롭을 쓰는 페이지에는 그 이벤트(`dragstart` · `drop`)가, 마우스를 따라가는 페이지에는 마우스 이동이 갑니다.
- `scroll` 은 `up` · `down` · `left` · `right` 로 화면의 80% 만큼(`--by` 로 픽셀 지정), `top` · `bottom` 으로 끝까지, 요소를 주면 그 요소가 보이게 스크롤합니다. 목록처럼 따로 스크롤되는 요소는 `--within <요소>` 로 고릅니다. 끝나면 현재 위치를 알려줍니다.
- `upload <요소> <파일...>` 은 `<input type="file">` 에 파일을 넣습니다. 상대 경로는 명령을 실행한 폴더 기준입니다. 파일 선택 창은 뜨지 않습니다.
  - 앱이 도는 컴퓨터의 파일만 넣을 수 있어서, SSH 워크스페이스의 터미널에서는 거절합니다.
  - `click` 이 파일 선택 창을 여는 버튼을 누르면 창을 띄우지 않고, 그 입력에 `upload` 하라고 알려줍니다.
- 페이지가 `alert` · `confirm` · 떠나기 전 확인 창을 띄우면, 그 명령은 창의 내용을 출력하고 끝납니다. 답하기 전에는 그 탭의 다른 명령이 거절됩니다.
  - `dialog` 로 지금 떠 있는 창을 보고, `dialog accept` 로 확인, `dialog dismiss` 로 취소합니다.
  - Electron 은 `prompt` 를 지원하지 않아서, 페이지의 `prompt()` 는 창 없이 오류를 냅니다.
  - 명령으로 답하면 앱에 떠 있던 같은 확인 창도 닫힙니다. 사용자가 앱에서 먼저 답해도 됩니다.
  - 명령이 그 탭을 다루기 전에 페이지가 띄운 창은 명령으로 답할 수 없습니다. 그때 명령은 페이지가 응답하지 않는다고 알려주니, 앱에서 답하세요.
- `console` 은 탭이 열린 뒤 페이지가 남긴 메시지를 최근 500개까지 보여줍니다.
- `network` 는 탭이 열린 뒤 페이지가 보낸 요청을 최근 500개까지 기록해 둡니다. 목록은 마지막 50개(`--last`)이고, `--type fetch,xhr` · `--url <텍스트>` 로 거르고, `--clear` 로 비웁니다.
  - 번호를 주면 그 요청의 헤더, 보낸 내용, 응답 본문(`--body` 로 글자 수, 기본 4000)을 보여줍니다. 본문은 페이지가 아직 갖고 있을 때만 나옵니다. 다른 페이지로 가면 이전 페이지의 본문은 사라집니다.
  - 새로 연 탭의 첫 페이지에서는 바로 불러오는 css · js 같은 요청이 빠질 수 있습니다. `browser reload` 뒤에는 모두 나옵니다.
- 브라우저 탭이 여러 개면 `--tab <id>` 로 고릅니다. 하나뿐이거나 보이는 탭이 하나면 생략할 수 있습니다.
- 페이지 안의 iframe 내용은 snapshot 에 나오지 않습니다.
- `pick` 은 그 탭을 보여주고 마우스 아래 요소를 강조합니다. 사용자가 클릭한 요소는 클릭되지 않고 골라집니다. 역할과 이름, `click` 등에 쓸 ref, CSS 선택자, 위치, 텍스트, HTML 을 출력하고 요소 스크린샷을 임시 폴더에 저장합니다.
  - Esc 로 취소합니다. 탭을 숨기거나 다른 페이지로 가도 취소됩니다.
  - 기본 2분 기다립니다(`--timeout`, 최대 10분). 시간이 다 되면 종료 코드 124 입니다. 명령을 Ctrl-C 로 멈추면 강조도 바로 꺼집니다.
  - shadow root 안의 요소에는 선택자를 주지 않습니다. ref 를 쓰세요.
  - 고르는 동안 그 탭의 `click` · `fill` · `type` · `press` 는 거절됩니다.
- `inspect <요소>` 는 사용자 클릭 없이 `pick` 과 같은 내용을 출력하고 요소 스크린샷을 저장합니다. 요소가 보이도록 스크롤합니다.
- `screenshot --element <요소>` 는 그 요소만 잘라 저장합니다. 화면보다 긴 요소도 통째로 찍습니다.
- 명령이 연 URL이나 누른 링크가 페이지가 아니라 파일이면 내려받습니다. 명령이 내려받은 파일은 사용자의 다운로드 폴더가 아니라 시스템 임시 폴더의 `nexus-downloads` 에 저장되고, 명령 출력에 그 경로가 나옵니다. 하루 지난 파일은 지웁니다. 사용자가 탭에서 직접 내려받은 파일은 다운로드 폴더에 저장되고 앱이 알림으로 알려줍니다.

## 화면 배치

에디터 영역의 그룹(분할된 칸)과 탭, 왼쪽 패널을 다룹니다.

```bash
nexus layout show                    # 분할 구조와 그룹 번호
nexus layout split "QA Form" right   # 탭을 오른쪽 새 그룹으로 (left · right · up · down)
nexus layout resize 2 30%            # 그룹 2 가 30% 차지 (--width · --height 로 방향 지정)
nexus layout even                    # 줄마다 그룹 크기 균등하게
nexus layout close 3                 # 그룹과 그 안의 탭 닫기
nexus tab move index.ts 1 --at 1     # 탭을 그룹 1 의 첫 자리로
nexus tab rename <탭> "dev server"   # 탭 이름 바꾸기 (--reset 으로 원래대로)
nexus tab pin <탭>                   # 탭 고정 (tab unpin 으로 해제)
nexus tab close <탭>                 # 탭 닫기
nexus tab close index.ts --others    # 그 탭 그룹의 다른 탭 닫기 (고정한 탭은 남김)
nexus tab close --saved              # 저장 안 한 변경이 없는 편집기 닫기 (탭을 주면 그 그룹만)
nexus tab close . --all              # 이 터미널 그룹의 탭 전부 (탭이 없으면 모든 그룹)
nexus tab save <탭>                  # 편집기의 저장 안 한 변경을 파일에 저장 (--all 로 전부)
nexus tab revert <탭>                # 저장 안 한 변경을 버리고 디스크 내용으로 (--all 로 전부)
nexus panel list                     # 왼쪽 패널이 보이는지, 너비, 파일 패널의 보기
nexus panel show git                 # 파일 패널을 git 보기로 (sidebar · files · search · git · agents · notes)
nexus panel show agents              # 파일 패널을 에이전트 목록으로
nexus panel hide sidebar
nexus panel resize files 320         # 패널 너비(px)
nexus reveal src/app.ts              # 파일 트리에서 그 파일을 펼쳐 선택
nexus problems                       # 열린 파일의 언어 서버 오류 · 경고
```

- 그룹은 `layout show` 의 번호, id, `.`(이 터미널의 그룹), 또는 그 안의 탭 이름으로 고릅니다. 번호는 그룹이 생기고 없어지면 바뀌니, 바꾼 뒤에는 `layout show` 로 다시 확인하세요.
- 분할 · 이동을 해도 사용자가 보던 그룹과 키보드 포커스는 그대로 둡니다.
- `tab close` 의 `--others` · `--saved` · `--all` 은 탭 표시줄 메뉴의 "다른 탭 닫기" · "저장된 탭 닫기" · "모두 닫기" 와 같습니다. 이 터미널은 닫지 않고, 저장 안 한 탭과 프로그램이 도는 터미널(`--force` 없이)은 남긴 채 이유를 알려줍니다. 이 터미널 말고 남긴 탭이 있으면 종료 코드 1 입니다.
- 이 터미널이 든 그룹은 닫지 않습니다. 저장 안 된 편집기가 있는 그룹도 닫지 않고, 프로그램이 도는 터미널은 `--force` 가 있어야 닫습니다.
- `problems` 는 에디터에 열린 파일만 봅니다(상태 표시줄의 오류 수와 같은 기준). 전체 검사는 프로젝트의 명령으로 하세요.

## 에이전트 뷰

창은 에이전트 뷰와 워크스페이스 화면 중 하나를 보여줍니다. 에이전트 뷰의 패널에는 어느 워크스페이스의 세션(Claude · Codex 탭, 터미널)이든 넣을 수 있습니다.

```bash
nexus view                           # 지금 보이는 화면 (agents · workspaces)
nexus view agents                    # 에이전트 뷰로 (view workspaces 로 워크스페이스 화면)
nexus view layout                    # 패널 분할 구조와 번호, 패널마다 든 세션과 그 워크스페이스
nexus view open codex                # 세션을 에이전트 뷰에 보여주기 (--panel 2 로 그 패널에)
nexus view split codex right         # 세션을 그 패널 오른쪽 새 패널로 (--of 로 나눌 패널 지정)
nexus view move codex 1 --at 1       # 세션을 패널 1 의 첫 자리로
nexus view remove codex              # 세션을 에이전트 뷰에서 빼기 (탭은 워크스페이스에 그대로)
nexus view close 2                   # 패널 닫기 (든 세션은 빠지고 탭은 그대로)
nexus view resize 1 30%              # 패널 1 이 30% 차지 (--width · --height)
nexus view even                      # 패널 크기 균등하게
nexus view focus 2                   # 패널 2 를 활성 패널로 (에이전트 뷰가 보이면 키보드도)
nexus view group workspace           # 에이전트 뷰 목록을 워크스페이스별로 묶기 (status 로 상태별, 인자 없으면 지금 묶기)
```

- 패널은 `view layout` 의 번호, id, `.`(이 세션이 든 패널, 없으면 활성 패널), 또는 그 안의 세션 이름으로 고릅니다.
- 세션은 탭처럼 이름 · id 로 고릅니다. 에이전트 뷰에 든 세션을 먼저 찾고, 없으면 이 워크스페이스(또는 `--workspace`)의 탭에서 찾습니다.
- `view open` 과 `view agents` 만 에이전트 뷰를 띄웁니다. 나머지는 보이는 화면과 활성 패널을 그대로 둡니다.

## 다른 워크스페이스 바꾸기

다른 워크스페이스에 파일을 열거나, 터미널에 입력하거나, Claude · Codex 탭에 보내거나 멈추거나 설정을 바꾸거나, 탭을 닫거나, 브라우저를 조작하거나, 그룹 배치 · 탭 이름 · 고정을 바꾸거나, 작업을 만들고 지우거나, 워크스페이스를 제거하는 일은 **설정 → 에이전트** 의 "다른 워크스페이스 변경" 을 따릅니다.

- **매번 묻기**(기본): 앱에 확인 창이 뜹니다. **이번만 허용** · **재시작 전까지 허용** · **허용 안 함** 중에서 고릅니다. 90초 안에 답하지 않으면 거절됩니다.
  - **재시작 전까지 허용**은 그 워크스페이스에서 그 워크스페이스로 가는 같은 종류의 변경에만 적용됩니다. 예를 들어 파일 열기를 허용해도 탭 닫기는 다시 묻습니다.
  - 터미널 입력, 명령을 주고 여는 새 터미널, 탭에 보내는 메시지, 프롬프트를 주고 여는 새 탭 · 작업은 매번 묻습니다. 확인 창에 입력할 내용, 명령, 메시지가 그대로 보입니다.
- **허용**: 묻지 않고 허용합니다.
- **허용 안 함**: 항상 거절합니다.

자기 워크스페이스는 묻지 않습니다. 읽기와 보여주기(`tab show`, `workspace switch`, `reveal`)도 묻지 않고, 앱 전체의 패널(`panel`) · 에이전트 뷰(`view`), 매니저 도크(`manager`), 설정 창 열기(`settings open`)와 워크스페이스 추가(`workspace add`)도 묻지 않습니다.

## 설정 바꾸기

```bash
nexus settings list                         # 설정 · 현재 값 · 받는 값 (바꾼 것은 *)
nexus settings get editor.fontSize
nexus settings set terminal.cursorStyle bar
nexus settings set editor.fontFamily ""     # 빈 값이면 시스템 글꼴
nexus settings reset editor.fontSize        # 기본값으로
nexus settings open agent                   # 설정 창을 그 페이지로 열어 사용자에게 보여주기
```

- 설정 창에서 바꾸는 것과 같습니다. 바로 반영되고 저장됩니다.
- 테마 · 언어 · 아이콘 · 창 투명도 · 비활성 패널 흐림, 에디터 · 터미널 · 채팅 글꼴, 커서 모양, 작업 에이전트, 에이전트 탭 기본 보기, 데스크톱 알림, 업데이트 자동 확인, 에이전트 안내를 바꿀 수 있습니다.
- 채팅 글꼴(`chat.fontSize` · `chat.fontFamily`)은 Claude · Codex 탭의 글꼴입니다. 크기는 답변 글자 크기(10~24, 기본 14)이고 탭의 다른 글자도 같은 비율로 바뀝니다. 글꼴을 빈 값으로 두면 앱 기본(Pretendard), `system-ui` 면 시스템 글꼴입니다.
- 켜고 끄는 값은 `on` / `off`, 숫자는 범위 안, 고르는 값은 목록 중 하나입니다.
- 앱 전체 설정이라 묻지 않습니다. 단, "다른 워크스페이스 변경" 과 "nexus 명령 허용" 은 사용자만 설정 창에서 바꿀 수 있습니다.
- 창 투명도는 명령으로는 0.2 아래로 내릴 수 없습니다(창이 안 보이면 되돌릴 수 없어서).
- `settings open` 의 페이지는 `appearance` · `editor` · `language-servers` · `terminal` · `notifications` · `agent` · `manager` · `browser-permissions` · `keybindings` · `about` 입니다. `terminal.cursorStyle` 처럼 설정 키를 주면 그 설정이 있는 페이지가 열립니다. 언어 서버 · 단축키 · 브라우저 권한 · 매니저처럼 사용자만 바꾸는 설정을 보여줄 때 씁니다.

## 에이전트에게 알려주기

앱에서 시작한 Claude Code 세션은 시작할 때 `nexus` 사용법을 짧게 안내받습니다. **설정 → 에이전트** 에서 끌 수 있습니다.

Codex 는 자동 안내가 없습니다. 쓰게 하려면 프로젝트의 `AGENTS.md` 에 한 줄 넣어 두세요.

```markdown
NexusCode 터미널에서는 `nexus` 명령으로 앱을 다룰 수 있다(`nexus help`).
```

- 앱 터미널의 `codex` 는 앱이 `--no-daemon` 을 붙여 실행합니다. 그래야 Codex 가 실행하는 명령이 이 터미널의 환경을 받아 `nexus` 가 이 탭을 가리킵니다.
- Codex 의 샌드박스 안에서는 앱에 연결할 수 없습니다. Codex 가 `nexus` 를 샌드박스 밖에서 실행하겠다고 승인을 요청하면 허용해 주세요.

> Windows 로컬 터미널에서는 PowerShell · 명령 프롬프트 · Git Bash 에서 시작한 세션만 안내받습니다. 다른 셸에서 쓰려면 위처럼 `CLAUDE.md` 에 적어 두세요.

## 끄기

**설정 → 에이전트** 의 "nexus 명령 허용" 으로 `nexus` 명령 전체를 끌 수 있습니다. 꺼져 있으면 모든 명령이 거절됩니다.
