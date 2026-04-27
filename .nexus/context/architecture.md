# 아키텍처

>> 현재 구현 상태는 roadmap.md를 참조하세요.

nexus-code의 아키텍처는 두 개의 런타임 경계로 나뉜다. 하나는 UI와 PTY를 담당하는 Electron 프로세스이고, 다른 하나는 워크스페이스마다 독립적으로 실행되는 Go sidecar 프로세스다.

## 프로세스 구성

애플리케이션은 다음 세 레이어의 프로세스로 동작한다.

**Electron main 프로세스**: 앱 생명주기, 터미널 PTY, IPC 게이트웨이, 패키징을 담당한다. 터미널 탭의 PTY는 모두 이 레이어에서 node-pty로 관리한다. VSCode가 extension host 대신 main 프로세스에서 PTY를 관리하는 패턴을 동일하게 따른다. 이 레이어는 active-workspace 파일트리 CRUD/watch/git 뱃지와 TypeScript/Python/Go LSP 진단 브리지를 맡고, preload의 editor API가 renderer에 노출한다.

**Electron renderer 프로세스**: React 기반 UI, 에디터, 터미널 렌더러, 파일트리, 프리뷰 패널이 실행된다. PTY 데이터는 IPC를 통해 main에서 전달받아 xterm.js로 표시한다. 파일트리와 Monaco 기반 편집기는 중앙 영역에서 Terminal 모드와 전환되며, Terminal 영역은 숨겨질 뿐 unmount하지 않는다.

**Go sidecar 프로세스**: 워크스페이스당 하나씩 독립적으로 실행된다. 하네스 관찰, sidecar 생명주기, WebSocket IPC의 워크스페이스 격리 경계를 담당한다. 장기 구조에서는 LSP 서버 감독, 파일 시스템 감시, git 연산도 sidecar 소유로 이동시키는 것이 의도다. sidecar가 직접 기동하는 자식 프로세스의 PTY 감독은 터미널 탭용 PTY(Electron main의 node-pty가 관리)와 구분된다.

## Per-Workspace Sidecar 모델

워크스페이스 격리 모델로 Per-Workspace Sidecar를 채택한다. 워크스페이스를 열면 해당 워크스페이스 전용 sidecar가 하나 기동된다. UI가 다른 워크스페이스로 전환되더라도 비활성 sidecar는 계속 실행 상태를 유지한다. 이 구조 덕분에 워크스페이스 전환이 tmux 창 전환처럼 즉각적이다.

### Sidecar Idle 정책 (3단)

sidecar의 생명주기는 세 가지 정책 중 하나로 운용된다.

**P1 Always-on** (기본값): 워크스페이스가 열려 있는 한 sidecar를 계속 실행한다. 전환 시 끊김이 없고 터미널 스크롤백과 진행 중인 AI 스트림이 모두 보존된다. MVP 기본 동작이다.

**P2 Suspend** (옵션): 설정으로 활성화할 수 있다. 지정한 idle 시간이 경과하면 sidecar를 일시 정지하고, 워크스페이스 복귀 시 재개한다. CPU 사용은 0이 되지만 메모리는 유지되고, 복귀 시 끊김이 없다. 워크스페이스를 20개 이상 동시에 여는 파워 유저를 위한 옵션이다.

**P3 Kill + Resume** (명시적 닫기 시만): 사용자가 워크스페이스 닫기 버튼을 눌렀을 때에만 sidecar를 종료한다. 메모리를 완전히 해제하며, 이후 해당 워크스페이스를 다시 열면 새 sidecar가 기동된다. AI 세션 대화 히스토리는 세션 파일 기반이므로 정책과 무관하게 항상 보존되지만, PTY 스크롤백은 손실된다.

## HarnessAdapter 플러그인 경계

AI 하네스 통합은 A2 "터미널 + 이벤트 Observer" 모델을 따른다. IDE는 AI 하네스의 TUI를 대체하거나 제어하지 않는다. 대신 읽기 전용으로 하네스의 동작을 관찰해 부가 UI(워크스페이스 상태 뱃지, diff 뷰, 사이드 패널, OS 알림)를 제공한다.

제품 코어에는 `HarnessAdapter` 인터페이스 계약만 고정된다. 각 하네스 구현(claude-code, opencode, codex)은 플러그인 레이어에 격리된다. Anthropic이나 OpenAI의 프로토콜이 변경되더라도 제품 코어에 영향이 전파되지 않는다. 이전 프로젝트에서 외부 API 변경으로 폐기까지 이어진 경험을 직접 반영한 설계 원칙이다.

관찰 메커니즘은 하네스마다 다르다. claude-code는 이번 기준선에서 Hooks API로 관찰하고, 세션 파일 tail은 세션 히스토리 표면 도입 시 합류한다. opencode는 SQLite 세션 DB와 이벤트 스트림으로, codex는 세션 파일과 JSON 출력으로 관찰한다. AI 세션 재진입은 per-turn spawn + `--resume` 패턴만 사용한다. 비공식 다중 턴 스트리밍 경로는 이전 프로젝트 폐기 교훈에 따라 사용하지 않는다.

claude-code Hooks 경로는 workspace-local settings 파일이 `nexus-sidecar hook` subcommand를 호출하고, 해당 subcommand가 워크스페이스별 Unix socket으로 이벤트를 전달하는 구조다. sidecar는 token 파일 검증 후 hook payload를 `harness/tab-badge`와 `harness/tool-call` 이벤트로 정규화해 WebSocket으로 main에 전달한다. main은 SidecarBridge observer event를 IPC로 renderer에 전달하고, renderer는 WorkspaceSidebar의 워크스페이스 상태 뱃지와 Right Shared Panel의 Tool live feed에 반영한다.

## IPC 계약

Electron main 프로세스와 Go sidecar 사이의 통신은 WebSocket 기반이다. 메시지 타입 계약은 JSON Schema를 기준으로 정의하고, 코드 생성 파이프라인으로 TypeScript 쪽과 Go 쪽의 타입을 동기화한다. 계약 드리프트는 CI에서 차단한다.

renderer 프로세스와 main 프로세스 사이는 Electron IPC(contextBridge)로 통신한다. renderer는 sidecar와 직접 통신하지 않는다.

## 핵심 데이터 흐름

```
UI (renderer)
  → Electron IPC
    → Main 프로세스
      → node-pty (터미널 PTY)
      → active-workspace file bridge (fs CRUD/watch + git CLI badges)
      → LSP diagnostics bridge (PATH-discovered stdio diagnostics)
      → WebSocket IPC
        → Go sidecar
          → AI 하네스 관찰 (파일 tail / SQLite / JSON)
          → Unix socket hook listener (claude-code)
          → fsnotify / git / LSP supervision (장기 sidecar 소유 의도)
```

이벤트 방향은 역방향도 존재한다. sidecar가 관찰한 AI 하네스 이벤트는 WebSocket과 main IPC를 거쳐 renderer에 전달된다. 파일 watch, git 뱃지, LSP 진단 이벤트는 main의 file/LSP bridge에서 발생해 preload editor API 경로로 renderer에 전달된다. 하네스 observer event의 초기 표면은 `harness/tab-badge`와 `harness/tool-call`이며, 각각 WorkspaceSidebar 상태 뱃지와 Right Shared Panel Tool live feed로 표시한다.

## 모노레포 구성

저장소는 단일 모노레포로 구성된다. 추상 레이어별로 구분하면 다음과 같다.

**packages/app**: Electron main과 renderer를 포함한 TypeScript 앱 패키지. 엔트리 포인트 두 개(main 프로세스 진입점, renderer HTML/JS 번들)가 여기에 위치한다. main의 terminal/file/LSP bridge, preload editor API, renderer의 파일트리·에디터·워크벤치 표면도 이 패키지에 있다.

**packages/shared**: 공유 TypeScript 타입, IPC 계약 코드 생성 결과물, HarnessAdapter 인터페이스를 포함한다. app과 하네스 어댑터 경계 양쪽에서 참조한다.

**packages/shared/src/harness/adapters**: claude-code, opencode, codex 각각의 HarnessAdapter 구현 경계다. 하네스별 관찰 로직과 이벤트 정규화가 격리된다.

**sidecar/**: Go 모듈 루트. 내부는 PTY 감독, 하네스 관찰, IPC 서버 등 서브시스템으로 나뉜다. 엔트리 포인트는 단일 바이너리를 생성하는 main 패키지다. LSP pass-through, git, 파일 와처는 장기 sidecar 소유 의도에 포함된다.

**proto/** (또는 schema/): IPC 메시지 계약 정의 파일. 이 디렉터리에서 TypeScript와 Go 양쪽 타입을 코드 생성한다.
