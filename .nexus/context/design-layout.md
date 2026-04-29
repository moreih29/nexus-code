Responsibility: workbench의 공간 구조, dock/grid 모델, panel 상태 표시, layout persistence를 정의한다.

# Design Layout

## 연결 문서

- 정체성·금지선: [design.md](./design.md)
- 토큰 값: [design-tokens.md](./design-tokens.md)
- 단축키·ARIA: [design-interactions.md](./design-interactions.md)
- FileTree toolbar와 empty state: [design-components.md](./design-components.md)
- renderer service 경계: [design-architecture.md](./design-architecture.md)

## 4 zone workbench

Plan #33 이후 우측 Shared Panel은 폐기한다. workbench는 좌→우 narrative를 가진 네 zone으로 구성한다.

1. **Workspace strip** — 가장 좌측. 열린 워크스페이스 식별·전환·상태 뱃지를 담당한다.
2. **Activity Bar** — 약 `48px`의 narrow icon stripe. collapse하지 않는다.
3. **Side Bar** — Activity Bar 선택 view의 내용을 표시한다. 폭은 가변이며 collapse/expand 상태를 가진다. 단축키는 [design-interactions.md](./design-interactions.md)의 Shortcut registry가 소유한다.
4. **Center** — flexlayout 기반 editor grid와 flexlayout border 기반 panel을 포함한다.

Activity Bar v0.1 view는 `Explorer`, `Search`, `Source Control`, `Tool`, `Session`, `Preview` 여섯 개다. `Run`, `Debug`, `Extensions`는 v0.2 이후 결정한다.

Workspace strip은 모든 열린 워크스페이스를 수직 리스트로 보여 준다. active workspace는 배경과 조용한 상태 cue로 구분하며, absolute path는 tooltip/accessible description으로 제공한다. 워크스페이스가 없을 때는 Workspace strip만 empty state를 표시하고, Side Bar의 Explorer 표면은 선택 없음 상태로 접는다.

## Center model

Center는 `flexlayout-react`를 직접 통합한다. 실패 시 `dockview-react`, 그마저 실패하면 자체 grid가 fallback이다.

구조는 두 층이다.

1. **Editor area** — flexlayout center grid. file editor, diff, terminal 등 tab type이 docking될 수 있으며 최대 6분할까지 지원한다.
2. **Bottom Panel** — flexlayout border. 기본 view는 `Terminal`, `Output`, `Problems`다.

Terminal은 기본 첫 실행 위치가 Bottom Panel이다. 사용자는 drag로 terminal tab을 Editor area로 이동할 수 있다. 마지막 terminal tab을 닫아도 Terminal view 자체는 남고 `+`로 재생성한다.

Bottom Panel은 left/right/top/bottom 네 위치로 이동할 수 있다. 위치 변경은 명령과 drag 경로를 모두 지원한다.

## Layout persistence

Layout state는 workspace별로 저장한다.

- 저장 형식: flexlayout model JSON
- 저장 key: `nx.layout.${workspaceId}`
- 복원 시점: workspace 전환 직후
- fallback: 저장 layout이 없거나 파싱 실패하면 기본 Terminal/Output/Problems Bottom Panel layout을 생성한다.

## flexlayout adoption criteria

`flexlayout-react`는 PR merge 전 다음 여섯 기준을 통과해야 채택으로 판정한다.

1. 4 pane에서 6분할까지 수평·수직 표시가 안정적이다.
2. top/right/bottom/left drop overlay가 정상 표시된다. corner overlay는 가능하면 포함한다.
3. drag 시 확장 방향 비대칭이 없다.
4. tear-off 후 floating panel 동작이 가능하다. 별도 OS window popout은 v0.2 범위다.
5. oklch CSS variable bridge를 통해 panel background와 border 색이 적용된다.
6. React 19 StrictMode에서 5회 mount/unmount 후 leak 없이 안정적이다.

## Active pane and focus

active pane을 Terminal Teal inset ring으로 감싸지 않는다.

- Active editor group header: `bg-zinc-600` (6분할 dark-mode luminance sanity를 통과하는 elevated card 계열)
- Inactive editor group header: `bg-card/60`
- Bottom Panel tabset 등 비-grid 표면은 기존 `bg-card` / `bg-card/60` 구분을 유지한다.
- Keyboard focus: `:focus-visible { outline: 1px solid var(--color-ring); outline-offset: -1px; }`
- Mouse click은 keyboard focus outline을 만들지 않는다.

focus outline 정책은 editor grid, Bottom Panel tabset, terminal focus 표면에 동일하게 적용한다.

## Resizer

Panel resize handle은 단일 컴포넌트로 통일한다.

- 시각 선: `1px`, `bg-border`
- hit area: pseudo-element 기준 `8px`
- vertical divider: `cursor: col-resize`
- horizontal divider: `cursor: row-resize`
- hover: 100ms delay 후 `bg-primary`
- drag 중: delay 없이 `bg-primary`

접근성 role과 keyboard step은 [design-interactions.md](./design-interactions.md)에서 정의한다.

## Workspace status badge

Workspace strip의 상태 뱃지는 4상태 입력을 3개 시각 출력으로 접는다. completed는 표시하지 않는다.

| 입력 상태 | 시각 출력 |
|---|---|
| running | `status-running` 8px dot |
| awaiting-approval | `status-attention` 8px dot |
| error | `destructive` 8px dot |
| completed | 뱃지 없음 |

상태명은 `sr-only` 텍스트로 제공한다.
