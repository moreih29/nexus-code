# NexusCode — `nexus` 명령

앱 안의 터미널에는 `nexus` 명령이 있습니다. Claude Code · Codex 같은 에이전트나 사용자가 이 명령으로 앱을 다룹니다. 다른 워크스페이스의 터미널과 에이전트 세션을 보고, 파일과 diff 를 사용자 앞에 열고, 다른 세션에 입력하고 끝나기를 기다리고, 앱의 브라우저를 조작할 수 있습니다.

```bash
nexus help              # 전체 명령
nexus <명령> --help     # 명령별 플래그
nexus status --json     # 모든 명령은 --json 으로 JSON 출력
```

- 앱 안 터미널(로컬 · SSH 워크스페이스)에서만 동작합니다. 앱 밖의 터미널에서는 `NexusCode is not reachable from this terminal` 이 나옵니다.
- 탭 · 워크스페이스는 id(앞 4자 이상), 이름이나 제목으로 고릅니다. `.` 은 지금 것입니다.
- Windows 에서는 PowerShell · 명령 프롬프트 · Git Bash 어디서든 같습니다. Git Bash 에서는 `/c/...` · `/tmp` 같은 경로도 그대로 쓸 수 있습니다.
- 출력은 영어입니다. 에이전트가 읽는 것을 기준으로 했습니다.

## 둘러보기

| 명령 | 하는 일 |
|---|---|
| `nexus status` | 이 터미널의 위치, 사용자가 보고 있는 탭 |
| `nexus workspace list` · `worktree list` | 워크스페이스와 워크트리 목록 |
| `nexus session list` | 모든 워크스페이스의 에이전트 세션(Claude Code, Codex, ...)과 상태 |
| `nexus tab list` · `terminal list` | 탭, 터미널과 그 안에서 도는 프로그램 (저장 안 한 편집기는 `(unsaved)`, `--unsaved` 로 그것만) |
| `nexus terminal read <탭>` | 터미널 화면(스크롤백 포함) 읽기 |
| `nexus port list` | 이 워크스페이스 터미널에서 실행한 프로그램(개발 서버 등)이 연 포트 |

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
| `nexus tab show <탭>` · `workspace switch <이름>` | 그 탭 · 워크스페이스를 사용자에게 보여주기 |
| `nexus notify "테스트 통과"` | 데스크톱 알림 |

새로 여는 탭은 명령을 실행한 터미널 위를 덮지 않고 옆 그룹에 열립니다. 그룹이 하나뿐이면 오른쪽으로 나눕니다. 키보드 포커스는 터미널에 그대로 둡니다.

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
nexus terminal wait <터미널 id> --workspace <작업 id>  # 출력된 명령 그대로. 그 에이전트가 끝날 때까지
nexus worktree new 환불 --command "codex -m gpt-5.5" --prompt "환불 API 추가해줘"   # 다른 에이전트 · 인자로
nexus worktree remove "로그인 수정" --delete-branch
```

- `worktree new` 는 앱의 **새 작업…** 과 같습니다.
  - 지금 HEAD 에서 이름을 딴 브랜치와 워크트리를 만듭니다. 작업 안에서 실행하면 그 작업이 속한 워크스페이스에서 만듭니다.
  - 작업 터미널에서 작업 에이전트 명령(설정 › 터미널, 기본 `claude`)을 `--prompt` 와 함께 실행합니다. 프롬프트는 명령의 맨 뒤 인자로 붙습니다.
  - `--command` 를 주면 그 작업에서만 설정 대신 그 명령을 씁니다. 에이전트를 고르고 인자도 붙일 수 있습니다(`--command "codex -m gpt-5.5"`, `--command "claude --model opus"`). `--command ""` 면 에이전트 없이 셸만 엽니다.
  - 그 터미널을 기다리는 명령을 출력합니다. 작업은 다른 워크스페이스라서 `terminal` 명령에 `--workspace` 가 필요합니다.
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
```

- `browser open /login` · `browser goto /login` 처럼 경로만 주면, 이 워크스페이스(작업이면 그 워크트리) 터미널의 프로그램이 연 포트로 엽니다. 포트를 미리 정해 둘 필요 없이 작업마다 따로 띄운 개발 서버를 찾아갑니다.
  - 열린 포트가 없거나 여러 개면 열지 않고 그 목록을 알려줍니다. 그때는 `localhost:5173/login` 처럼 포트를 적어 주세요.
  - 포트는 `nexus port list` 로 봅니다. 상태 표시줄 오른쪽과 제목 표시줄의 작업 메뉴에도 나옵니다.
  - 49152 이상의 포트, Docker 가 연 포트, 셸을 떠나 데몬으로 도는 서버는 찾지 못합니다.
  - SSH 워크스페이스의 포트는 원격 호스트에 있고 앱이 포워딩하지 않아서, 경로만으로는 열 수 없습니다.
  - 로컬 파일은 `file:///경로` 로 엽니다.
- 요소는 마지막 `snapshot` 의 ref(`e12`)나, 요소 하나만 맞는 CSS 선택자로 고릅니다. 페이지가 다시 로드되면 snapshot 을 새로 찍어야 합니다.
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
nexus tab save <탭>                  # 편집기의 저장 안 한 변경을 파일에 저장 (--all 로 전부)
nexus tab revert <탭>                # 저장 안 한 변경을 버리고 디스크 내용으로 (--all 로 전부)
nexus panel show git                 # 파일 패널을 git 보기로 (sidebar · files · search · git)
nexus panel hide sidebar
nexus panel resize files 320         # 패널 너비(px)
nexus reveal src/app.ts              # 파일 트리에서 그 파일을 펼쳐 선택
nexus problems                       # 열린 파일의 언어 서버 오류 · 경고
```

- 그룹은 `layout show` 의 번호, id, `.`(이 터미널의 그룹), 또는 그 안의 탭 이름으로 고릅니다. 번호는 그룹이 생기고 없어지면 바뀌니, 바꾼 뒤에는 `layout show` 로 다시 확인하세요.
- 분할 · 이동을 해도 사용자가 보던 그룹과 키보드 포커스는 그대로 둡니다.
- 이 터미널이 든 그룹은 닫지 않습니다. 저장 안 된 편집기가 있는 그룹도 닫지 않고, 프로그램이 도는 터미널은 `--force` 가 있어야 닫습니다.
- `problems` 는 에디터에 열린 파일만 봅니다(상태 표시줄의 오류 수와 같은 기준). 전체 검사는 프로젝트의 명령으로 하세요.

## 다른 워크스페이스 바꾸기

다른 워크스페이스에 파일을 열거나, 터미널에 입력하거나, 탭을 닫거나, 브라우저를 조작하거나, 그룹 배치 · 탭 이름 · 고정을 바꾸거나, 작업을 만들고 지우거나, 워크스페이스를 제거하는 일은 **설정 → 에이전트 CLI** 의 "다른 워크스페이스 변경" 을 따릅니다.

- **매번 묻기**(기본): 앱에 확인 창이 뜹니다. **이번만 허용** · **재시작 전까지 허용**(그 워크스페이스 쌍에 대해) · **허용 안 함** 중에서 고릅니다. 90초 안에 답하지 않으면 거절됩니다.
- **허용**: 묻지 않고 허용합니다.
- **허용 안 함**: 항상 거절합니다.

자기 워크스페이스는 묻지 않습니다. 읽기와 보여주기(`tab show`, `workspace switch`, `reveal`)도 묻지 않고, 앱 전체의 패널(`panel`)과 워크스페이스 추가(`workspace add`)도 묻지 않습니다.

## 설정 바꾸기

```bash
nexus settings list                         # 설정 · 현재 값 · 받는 값 (바꾼 것은 *)
nexus settings get editor.fontSize
nexus settings set terminal.cursorStyle bar
nexus settings set editor.fontFamily ""     # 빈 값이면 시스템 글꼴
nexus settings reset editor.fontSize        # 기본값으로
```

- 설정 창에서 바꾸는 것과 같습니다. 바로 반영되고 저장됩니다.
- 테마 · 언어 · 아이콘 · 창 투명도 · 비활성 패널 흐림, 에디터 · 터미널 글꼴, 커서 모양, 작업 에이전트 명령, 세션 탭 기본 보기, 데스크톱 알림, 업데이트 자동 확인, 에이전트 안내를 바꿀 수 있습니다.
- 켜고 끄는 값은 `on` / `off`, 숫자는 범위 안, 고르는 값은 목록 중 하나입니다.
- 앱 전체 설정이라 묻지 않습니다. 단, "다른 워크스페이스 변경" 과 에이전트 CLI 켜기 · 끄기는 사용자만 설정 창에서 바꿀 수 있습니다.
- 창 투명도는 명령으로는 0.2 아래로 내릴 수 없습니다(창이 안 보이면 되돌릴 수 없어서).

## 에이전트에게 알려주기

앱에서 시작한 Claude Code 세션은 시작할 때 `nexus` 사용법을 짧게 안내받습니다. **설정 → 에이전트 CLI** 에서 끌 수 있습니다.

Codex 는 자동 안내가 없습니다. 쓰게 하려면 프로젝트의 `AGENTS.md` 에 한 줄 넣어 두세요.

```markdown
NexusCode 터미널에서는 `nexus` 명령으로 앱을 다룰 수 있다(`nexus help`).
```

- 앱 터미널의 `codex` 는 앱이 `--no-daemon` 을 붙여 실행합니다. 그래야 Codex 가 실행하는 명령이 이 터미널의 환경을 받아 `nexus` 가 이 탭을 가리킵니다.
- Codex 의 샌드박스 안에서는 앱에 연결할 수 없습니다. Codex 가 `nexus` 를 샌드박스 밖에서 실행하겠다고 승인을 요청하면 허용해 주세요.

> Windows 로컬 터미널에서는 PowerShell · 명령 프롬프트 · Git Bash 에서 시작한 세션만 안내받습니다. 다른 셸에서 쓰려면 위처럼 `CLAUDE.md` 에 적어 두세요.

## 끄기

**설정 → 에이전트 CLI** 에서 `nexus` 명령 전체를 끌 수 있습니다. 꺼져 있으면 모든 명령이 거절됩니다.
