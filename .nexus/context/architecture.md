# Architecture

Nexus Code는 **에이전트 감독자를 위한 통합 워크벤치**이며, Nexus 생태계의 **Supervision layer**다. Claude Code(현재)와 OpenCode(계획) 세션을 외부에서 spawn·관찰하고, 권한 요청을 **Policy Enforcement Point**로 중재한다. 내부는 네 개의 패키지(shared/server/web/electron)로 구성되며, 각 패키지는 단일 책임을 가진다.

## Nexus ecosystem 3-layer 프레임

Nexus 생태계는 세 층위로 구성된다. 각 층위는 독립 레포지토리이며 역할이 구분된다.

### Authoring layer — nexus-core
프롬프트, neutral metadata, vocabulary를 정의하는 canonical source. 집행 semantics를 포함하지 않는다. claude-nexus, opencode-nexus, nexus-code 모두가 이를 **read-only로 소비**한다.

### Execution layer — claude-nexus ↔ opencode-nexus
각각 Claude Code, OpenCode 하네스 내부에서 에이전트를 조립·디스패치하고, 권한을 집행하며, 태스크 파이프라인을 소유한다. 둘은 **sibling 관계**(parent-child 아님)이며 bidirectional flip 대상이다.

### Supervision layer — nexus-code
Execution layer 세션을 외부에서 spawn·관찰·권한 중재·시각화한다. **flip 외부**에 위치하며, 여러 Execution layer 세션을 동시에 감독할 수 있는 별도 층위다.

> **주의**: 이 3층위 프레임은 **내부 아키텍처 문서 전용**이다(Primer §1.4). 외부 포지셔닝 문서(README, landing page)에는 노출하지 않는다.

## Supervision layer 내부 패키지 구조

nexus-code(Supervision layer)의 내부는 4개 패키지로 구성된다.

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

`@nexus/shared`는 `@moreih29/nexus-core`를 **build-time devDependency**로 소비한다. 런타임 import 없음 — `generate-metadata` 스크립트가 nexus-core의 agents/vocabulary 파일을 읽어 TypeScript 상수로 inline한다. 이는 Plan Session #1에서 확정된 "3rd read-only consumer" 합류 방식이다(claude-nexus, opencode-nexus에 이어).

### `@nexus/server` — 오케스트레이션 엔진
Hono 기반 HTTP 서버. Layered 아키텍처로 책임을 분리한다.

- **Routes**: 엔드포인트 계약 (health, workspace, session, events, hooks, files, git, settings, approval, cli-settings)
- **Services**: 세션 생명주기, 권한 평가 등 도메인 로직
- **Adapters**: 외부 세계와의 경계. Plan #6(2026-04) 결정으로 역할 기반 폴더로 재편됨:
  - `adapters/claude-code/` — CC 전용 구현체 (cli-process, stream-parser, claude-code-host, cli-settings-proxy, history-parser, tool-categorizer, protected-paths, process-supervisor, workspace-group)
  - `adapters/approval/` — 하네스 중립 권한 파이프라인 (bridge.ts. tool-categorizer는 CC 전용 분리)
  - `adapters/security/` — 하네스 중립 경로 가드 (path-guard, path-guard-preflight)
  - `adapters/hooks/` — HTTP hook endpoint 라우팅 (hook-manager.ts)
  - `adapters/db/` — SessionStore / WorkspaceStore / SettingsStore / ApprovalPolicyStore
  - `adapters/events/` — EventEmitter pub/sub
  - `adapters/logging/` — WorkspaceLogger. 로그 기본 위치는 `~/.nexus-code/logs/`(`NEXUS_LOG_DIR` env로 재정의 가능). 디렉토리 구조:
    ```
    ~/.nexus-code/
    ├── nexus.db                         # SQLite (NEXUS_DB_PATH)
    └── logs/                            # NEXUS_LOG_DIR (기본)
        ├── {workspace-sanitized}/
        │   └── {date}.jsonl             # 워크스페이스별 (14 type)
        └── _system/
            ├── electron-main-{date}.log # Electron main 영속
            └── dev-{date}.log           # dev orchestrator (NEXUS_LOG_DEV=1)
    ```
    `{workspace-sanitized}` 매핑은 `packages/server/src/utils/workspace-id.ts`의 `workspacePathToId()` 함수로 단일화되어 있다. `adapters/claude-code/history-parser.ts`도 동일 유틸을 사용하여 경로 → ID 변환이 한 곳에서만 이루어진다.

    모든 HTTP 요청은 `request-id` → `logging` 미들웨어 순서로 처리되어 `AppVariables = { requestId, logger }`가 context에 주입된다. child logger는 `requestId`를 자동 bind하여 router → service → adapter → CLI hook → SSE event까지 동일 ID로 페어링된다. web 클라이언트는 `packages/web/src/api/client.ts`의 fetch util이 모든 outbound 요청에 `x-request-id` 헤더를 자동 부착하고, 응답 헤더의 서버 발급 ID를 캡처한다.
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
| Web → Server (dev only) | HTTP POST (`/api/dev/client-log`) | 클라이언트 console 로그 수집 |

## 설계 원칙

1. **단방향 의존**: shared ← server ← web ← electron. 역방향 참조 금지.
2. **서버가 유일한 상태 저장소**: 클라이언트 캐시는 React Query가, 서버 상태는 SQLite가 관리. 둘 사이 동기화는 SSE로 푸시된다.
3. **타입 계약 우선**: 새 기능은 shared의 Zod 스키마부터 정의한 뒤 server → web 순으로 구현한다.
4. **외부 경계는 Adapter로 격리**: CLI 프로세스, DB, 파일 시스템, 로거 등 I/O는 모두 adapter 계층에 배치한다. Services는 Adapter 인터페이스에만 의존.
5. **kebab-case 파일명**: 모든 패키지에서 일관.
6. **Adapter import 경계**: `routes/`·`services/`·`domain/`은 `adapters/claude-code/**`를 직접 import 금지(예외 없음). `ClaudeCodeHost`는 `app.ts`(composition root)에서만 인스턴스화하고 services에는 `AgentHost` interface로 주입한다. 이 경계는 Phase 3 OpenCode adapter 추가 시 shotgun surgery를 방지하는 핵심 봉쇄선이다. (ESLint `no-restricted-paths` + leak canary CI는 커밋 #5에서 적용 예정.)

## 빌드/개발 오케스트레이션

`scripts/dev.ts`가 Bun으로 실행되며 전체 개발 환경을 조립한다.

1. `@nexus/shared` 빌드 (타입이 먼저 준비돼야 나머지가 컴파일됨)
2. `@nexus/server` + `@nexus/web` dev 서버 병렬 기동
3. `/api/health` + 웹 데브서버(5173)가 준비될 때까지 대기
4. Electron 런치
5. Electron 종료 시 전체 cleanup

빌드 순서가 어긋나면 shared의 최신 타입이 server/web에 반영되지 않아 컴파일이 무작위로 실패한다.
