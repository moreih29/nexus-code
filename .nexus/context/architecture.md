# Architecture

Nexus Code는 Claude Code CLI를 GUI로 오케스트레이션하는 로컬 워크스테이션이다. 사용자와 CLI 사이에 네 개의 계층을 두고, 각 계층은 단일 책임을 가진다.

## 계층 구조

```
┌─────────────────────────────────────────┐
│  Electron (desktop shell)               │  프로세스 관리 + 창
├─────────────────────────────────────────┤
│  Web (React)                            │  UI + 상태
├─────────────────────────────────────────┤
│  Server (Hono)                          │  오케스트레이션 + DB
├─────────────────────────────────────────┤
│  Shared (Zod schemas)                   │  타입 계약
└─────────────────────────────────────────┘
               ↓ spawn
       Claude Code CLI 프로세스
```

### `@nexus/shared` — 타입 계약
모든 계층이 참조하는 단일 SoT(Source of Truth). Zod 스키마로 Workspace, Session, Approval, SessionEvent, Permission을 정의하고, `Result<T, AppError>` 모나드로 에러 처리 표준을 제공한다. 이 계층에 없는 타입은 존재하지 않는다고 간주한다.

### `@nexus/server` — 오케스트레이션 엔진
Hono 기반 HTTP 서버. Layered 아키텍처로 책임을 분리한다.

- **Routes**: 엔드포인트 계약 (health, workspace, session, events, hooks, files, git, settings, approval, cli-settings)
- **Services**: 세션 생명주기, 권한 평가 등 도메인 로직
- **Adapters**: 외부 세계와의 경계 (ProcessSupervisor = CLI 프로세스, EventEmitter = pub/sub, HookManager = 사전 승인 정책, SessionStore/WorkspaceStore = Better-SQLite3 DB, WorkspaceLogger = 워크스페이스별 디버그 로그)
- **Domain**: WorkspaceRegistry (메모리 레지스트리)

서버는 **상태를 갖는 유일한 계층**이다. SQLite에 워크스페이스/세션/설정/승인 정책이 영속화되며, 다른 계층은 서버를 통하지 않고서는 상태를 변경하지 않는다.

### `@nexus/web` — UI 계층
React 함수 컴포넌트 + Zustand 스토어. 서버 상태(워크스페이스, 세션, 설정)와 UI 상태(패널, 레이아웃, 입력)를 분리한다. 서버 통신은 Fetch + React Query(캐싱/재검증), 실시간 업데이트는 SSE 리스너가 Zustand 스토어를 갱신한다. 다크 테마 고정.

### `@nexus/electron` — 데스크톱 셸
BrowserWindow 호스팅 + 서버/웹 프로세스 오케스트레이션. 보안 원칙상 `contextIsolation: true`, `nodeIntegration: false`. 개발 모드는 Vite 데브서버(5173)를, 프로덕션은 서버가 호스팅하는 정적 파일(3000)을 로드한다. IPC는 폴더 선택 같은 네이티브 기능에만 제한적으로 노출된다.

## 통신 경로

| 방향 | 프로토콜 | 용도 |
|------|----------|------|
| Web → Server | HTTP (Fetch) | 커맨드/쿼리 모두 |
| Server → Web | SSE (`/api/workspaces/{path}/events`) | 실시간 세션 이벤트 |
| CLI → Server | HTTP POST (`/hooks/pre-tool-use`) | 권한 제어 훅 |
| Server → CLI | stdin/stdout (ProcessSupervisor) | 프로세스 라이프사이클 |
| Electron → Web | IPC (preload bridge) | 네이티브 기능(폴더 선택 등) |

## 설계 원칙

1. **단방향 의존**: shared ← server ← web ← electron. 역방향 참조 금지.
2. **서버가 유일한 상태 저장소**: 클라이언트 캐시는 React Query가, 서버 상태는 SQLite가 관리. 둘 사이 동기화는 SSE로 푸시된다.
3. **타입 계약 우선**: 새 기능은 shared의 Zod 스키마부터 정의한 뒤 server → web 순으로 구현한다.
4. **외부 경계는 Adapter로 격리**: CLI 프로세스, DB, 파일 시스템, 로거 등 I/O는 모두 adapter 계층에 배치한다. Services는 Adapter 인터페이스에만 의존.
5. **kebab-case 파일명**: 모든 패키지에서 일관.

## 빌드/개발 오케스트레이션

`scripts/dev.ts`가 Bun으로 실행되며 전체 개발 환경을 조립한다.

1. `@nexus/shared` 빌드 (타입이 먼저 준비돼야 나머지가 컴파일됨)
2. `@nexus/server` + `@nexus/web` dev 서버 병렬 기동
3. `/api/health` + 웹 데브서버(5173)가 준비될 때까지 대기
4. Electron 런치
5. Electron 종료 시 전체 cleanup

빌드 순서가 어긋나면 shared의 최신 타입이 server/web에 반영되지 않아 컴파일이 무작위로 실패한다.
