# NexusCode — `nexus` 명령

앱 안의 터미널에는 `nexus` 명령이 있습니다. Claude Code · Codex 같은 에이전트나 사용자가 이 명령으로 앱을 다룹니다. 다른 워크스페이스의 터미널과 에이전트 세션을 보고, 파일과 diff 를 사용자 앞에 열고, 다른 세션에 입력하고 끝나기를 기다리고, 앱의 브라우저를 조작할 수 있습니다.

```bash
nexus help              # 전체 명령
nexus <명령> --help     # 명령별 플래그
nexus status --json     # 모든 명령은 --json 으로 JSON 출력
```

- 앱 안 터미널(로컬 · SSH 워크스페이스)에서만 동작합니다. 앱 밖의 터미널에서는 `NexusCode is not reachable from this terminal` 이 나옵니다.
- 탭 · 워크스페이스는 id(앞 4자 이상), 이름이나 제목으로 고릅니다. `.` 은 지금 것입니다.
- 출력은 영어입니다. 에이전트가 읽는 것을 기준으로 했습니다.

## 둘러보기

| 명령 | 하는 일 |
|---|---|
| `nexus status` | 이 터미널의 위치, 사용자가 보고 있는 탭 |
| `nexus workspace list` · `worktree list` | 워크스페이스와 워크트리 목록 |
| `nexus session list` | 모든 워크스페이스의 에이전트 세션(Claude Code, Codex, ...)과 상태 |
| `nexus tab list` · `terminal list` | 탭, 터미널과 그 안에서 도는 프로그램 |
| `nexus terminal read <탭>` | 터미널 화면(스크롤백 포함) 읽기 |

읽기는 어느 워크스페이스든 허락 없이 됩니다.

## 사용자 앞에 열기

| 명령 | 하는 일 |
|---|---|
| `nexus open src/app.ts:42` | 파일을 그 줄에서 열기 |
| `nexus diff src/app.ts` | 변경 사항 diff 열기 (`--staged`, `--base REF`) |
| `nexus terminal new --command "bun dev"` | 새 터미널에서 명령 실행 (기본은 뒤에 열기, `--show` 로 보이기) |
| `nexus browser open localhost:3000` | 브라우저 탭 열기 |
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
  - **Claude Code**: 앱 훅으로 정확히 압니다. 마지막 답변까지 출력합니다.
  - **Codex 등 다른 에이전트**: 알림을 보내거나 출력이 `--quiet`(기본 5초) 동안 멈추면 끝난 것으로 봅니다.
  - **일반 셸**: 프롬프트로 돌아오면 끝난 것으로 봅니다.
- 기본 대기 시간은 10분, 최대 30분입니다(`--timeout`). 시간이 다 되면 종료 코드 124 입니다.
- `--match` 는 지금 화면 전체를 봅니다. 입력한 명령 줄 자체가 걸릴 수 있으니 `'^ready'` 처럼 줄 시작에 고정하는 것이 좋습니다.
- 자기 터미널에는 입력할 수 없습니다. 도구 허용을 기다리는 Claude Code 에도 입력하지 않습니다. 허용 여부는 사용자가 정합니다.

## 브라우저 조작

앱의 브라우저 탭을 에이전트가 직접 다룹니다. 화면에 안 보이는 탭에서도 동작합니다.

```bash
nexus browser open localhost:5173/login
nexus browser snapshot            # 페이지 구조와 요소 ref (e1, e2, ...)
nexus browser fill e3 me@example.com
nexus browser click e6
nexus browser press Enter
nexus browser wait --text "Welcome"
nexus browser screenshot --out shot.png
nexus browser console --errors
nexus browser eval "document.title"
```

- 요소는 마지막 `snapshot` 의 ref(`e12`)나, 요소 하나만 맞는 CSS 선택자로 고릅니다. 페이지가 다시 로드되면 snapshot 을 새로 찍어야 합니다.
- 클릭은 실제 마우스 이벤트입니다. 다른 요소가 덮고 있으면 거절합니다(`--force` 로 그 자리를 그냥 클릭).
- `console` 은 탭이 열린 뒤 페이지가 남긴 메시지를 최근 500개까지 보여줍니다.
- 브라우저 탭이 여러 개면 `--tab <id>` 로 고릅니다. 하나뿐이거나 보이는 탭이 하나면 생략할 수 있습니다.
- 페이지 안의 iframe 내용은 snapshot 에 나오지 않습니다.

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

다른 워크스페이스에 파일을 열거나, 터미널에 입력하거나, 탭을 닫거나, 브라우저를 조작하거나, 그룹 배치 · 탭 이름 · 고정을 바꾸는 일은 **설정 → 에이전트 CLI** 의 "다른 워크스페이스 변경" 을 따릅니다.

- **매번 묻기**(기본): 앱에 확인 창이 뜹니다. **이번만 허용** · **재시작 전까지 허용**(그 워크스페이스 쌍에 대해) · **허용 안 함** 중에서 고릅니다. 90초 안에 답하지 않으면 거절됩니다.
- **허용**: 묻지 않고 허용합니다.
- **허용 안 함**: 항상 거절합니다.

자기 워크스페이스는 묻지 않습니다. 읽기와 보여주기(`tab show`, `workspace switch`, `reveal`)도 묻지 않고, 앱 전체의 패널(`panel`)도 묻지 않습니다.

## 에이전트에게 알려주기

앱에서 시작한 Claude Code 세션은 시작할 때 `nexus` 사용법을 짧게 안내받습니다. **설정 → 에이전트 CLI** 에서 끌 수 있습니다.

Codex 는 자동 안내가 없습니다. 쓰게 하려면 프로젝트의 `AGENTS.md` 에 한 줄 넣어 두세요.

```markdown
NexusCode 터미널에서는 `nexus` 명령으로 앱을 다룰 수 있다(`nexus help`).
```

> Windows 로컬 터미널에서는 Claude Code 래퍼가 없어 자동 안내가 붙지 않습니다. 필요하면 위처럼 `CLAUDE.md` 에 적어 두세요.

## 끄기

**설정 → 에이전트 CLI** 에서 `nexus` 명령 전체를 끌 수 있습니다. 꺼져 있으면 모든 명령이 거절됩니다.
