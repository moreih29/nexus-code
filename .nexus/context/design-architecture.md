Responsibility: design-facing renderer 구조, service/parts 경계, layout 회귀 가드 정책을 정의하며 전체 시스템 아키텍처는 architecture.md에 위임한다.

# Design Architecture

## 연결 문서

- 제품 철학: [design.md](./design.md)
- 토큰 bridge: [design-tokens.md](./design-tokens.md)
- layout model: [design-layout.md](./design-layout.md)
- interaction contract: [design-interactions.md](./design-interactions.md)
- component rendering: [design-components.md](./design-components.md)
- 전체 데이터 흐름: [architecture.md](./architecture.md)

## Scope

이 문서는 renderer design 구조만 다룬다. main process, sidecar, IPC 전체 흐름은 [architecture.md](./architecture.md)의 소유다.

목표는 service-oriented renderer다. DI container는 도입하지 않는다. 컴포넌트는 service interface를 import하고, 임의 store 직접 접근을 금지한다.

## Service interfaces

Plan #33 이후 renderer service interface는 여덟 개다.

| Interface | 책임 |
|---|---|
| `IEditorGroupsService` | flexlayout center grid model, tab CRUD, active tab/group |
| `IBottomPanelService` | Bottom Panel view, 위치, toggle |
| `IActivityBarService` | view 전환, Side Bar content routing |
| `IWorkspaceService` | workspace CRUD, active workspace, sidebar state, workspace별 layout persistence |
| `ITerminalService` | PTY tab data. panel view 책임과 분리 |
| `IFilesService` | file tree CRUD, watch, git badge |
| `IGitService` | git status, branch, sidecar 통신 |
| `ILspService` | diagnostics, completion, symbol, document lifecycle |

## Parts model

Renderer는 다음 part 단위로 분해한다.

- `parts/workspace-strip`
- `parts/activity-bar`
- `parts/side-bar`
- `parts/editor-groups`
- `parts/bottom-panel`

`packages/app/src/renderer/services/`는 interface와 zustand 기반 구현을 둔다. `packages/app/src/renderer/parts/`는 service를 조립해 화면을 만든다.

`App.tsx`의 목표 책임은 workspace shell 조립과 service wiring이다. localStorage IO, shortcut binding, IPC adapter, layout mutation은 service로 흡수한다.

## Layout-critical regression guard

회귀 가드의 normative rules는 아래 Architectural guard rules가 소유한다. flexlayout 채택 기준의 상세 항목은 [design-layout.md](./design-layout.md)에만 둔다.

신규 system smoke fixture는 다음 세 개다.

| Fixture | 책임 |
|---|---|
| `dock-layout-runtime.test.ts` | dock/grid runtime adoption과 drag/floating/mount 안정성 검증 |
| `activity-bar-runtime.test.ts` | Activity Bar view 전환, Side Bar content 교체, collapse/expand 검증 |
| `workspace-layout-persist-runtime.test.ts` | workspace 전환 시 layout 저장·복원 검증 |

기존 file tree 관련 runtime fixture는 4 zone layout과 Explorer view context에 맞게 갱신한다.

## Test pyramid

| Layer | 도구 | 책임 |
|---|---|---|
| 1. Service unit | `bun test` | service 메서드 입력/출력과 store mutation |
| 2. Service contract | TypeScript type-level + runtime sanity | interface signature 안정성 |
| 3. Component unit | existing `*.test.tsx` | React component 단위 동작 |
| 4. Integration | `bun test` | service 조합 경로 |
| 5. System smoke | Electron + Vite fixture | full stack 시나리오 |
| 6. Regression policy | CI gate 또는 PR checklist | fixture/contract 동반 강제 |

## Architectural guard rules

테스팅 회귀 가드 정책은 `testing-policy.md`를 참조한다.

1. layout-critical 또는 service-boundary 신규 도입 시 동일 PR에 fixture를 포함한다.
2. service interface 변경 시 contract test를 함께 갱신한다.
3. service unit test는 메서드 단위 100%를 목표로 한다. branch coverage 100% 요구가 아니다.
4. shadcn forwardRef wrapper로 layout-critical library를 감싸지 않는다.
