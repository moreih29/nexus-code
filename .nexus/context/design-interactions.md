Responsibility: keyboard, command palette, file tree 조작 문법, drag/drop, context menu, ARIA 정책을 정의한다.

# Design Interactions

## 연결 문서

- 철학과 금지선: [design.md](./design.md)
- 레이아웃 표면: [design-layout.md](./design-layout.md)
- 토큰과 아이콘: [design-tokens.md](./design-tokens.md)
- FileTree toolbar rendering: [design-components.md](./design-components.md)
- service/test 경계: [design-architecture.md](./design-architecture.md)

## Shortcut registry

MVP는 단일 shortcut registry를 사용한다. 한국어 IME 조합 중 전역 단축키는 composition guard를 따라 전달을 차단한다.

| 단축키 | 동작 |
|---|---|
| `Cmd+O` | Workspace 열기 |
| `Cmd+1/2/3` | 워크스페이스 탭 전환, active row `scrollIntoView({ block: "nearest" })` 보정 |
| `Cmd+W` | 활성 에디터 탭 닫기. 없으면 활성 워크스페이스 닫기로 fallback |
| `Cmd+Shift+W` | 활성 워크스페이스 닫기 |
| `Cmd+T` | 새 터미널 탭 |
| `Cmd+Shift+[` / `Cmd+Shift+]` | 이전/다음 탭 |
| `Cmd+B` | Side Bar collapse/expand |
| `Cmd+J` | Bottom Panel toggle |
| `Cmd+\` | Editor split right toggle |
| `Cmd+Shift+M` | 현재 tabset maximize toggle |
| `Cmd+Alt+←` / `Cmd+Alt+→` / `Cmd+Alt+↑` / `Cmd+Alt+↓` | 활성 탭을 화면상 인접한 editor group으로 이동. 인접 group이 없으면 no-op(no wrap-around) |
| `Cmd+P` / `Cmd+Shift+P` | Command palette 열기 |
| ``Ctrl+` `` | Terminal view focus |
| `Cmd+Shift+F` | Search view 열기 + input focus |
| `Cmd+Shift+H` | Search view를 replace mode로 열기 |
| `Cmd+G` | Search 결과 다음 match 이동 |
| `F2` | File tree 선택 항목 rename |
| `Del` | File tree delete confirmation 열기 |
| `Cmd+A` | File tree에서 현재 폴더 내 항목 전체 선택(recursive 아님) |
| `Cmd+Enter` | Source Control inline commit 실행 |
| `Cmd+Shift+Enter` | Source Control amend 실행 |
| `Esc` | 팔레트·오버레이 닫기, Search 결과 dismiss, File tree multi-select clear |
| `j` | diff tab 다음 change 이동 |
| `k` | diff tab 이전 change 이동 |

단축키 전용 기능은 만들지 않는다. 모든 명령은 팔레트나 visible control 중 하나 이상의 대체 경로를 가진다.

## Command palette

MVP에 `cmdk` command palette를 포함한다. `Cmd+P`와 `Cmd+Shift+P`는 동일 palette를 연다.

명령 그룹은 다음 다섯 개다.

- Workspace
- View
- Editor
- Terminal
- App

Preferences는 placeholder 명령으로 둔다. 파일 quick-open 모드는 MVP command palette 범위에 포함하지 않는다.

Editor group 이동 명령은 단축키와 팔레트 등가 경로를 모두 제공한다.
Tear-off는 rare action으로 기본 단축키를 배정하지 않고, 팔레트와 tab context menu로만 노출한다.

| 팔레트 entry | 명령 ID | 기본 단축키 |
|---|---|---|
| Move Editor Left | `editor.moveActiveTabLeft` | `Cmd+Alt+←` |
| Move Editor Right | `editor.moveActiveTabRight` | `Cmd+Alt+→` |
| Move Editor Up | `editor.moveActiveTabUp` | `Cmd+Alt+↑` |
| Move Editor Down | `editor.moveActiveTabDown` | `Cmd+Alt+↓` |
| Move Editor to New Floating Window / 탭을 부동 창으로 분리 | `workbench.action.tearOffEditorToFloating` | 없음 |

## File tree interaction grammar

File tree는 VS Code interaction grammar를 MVP 기준으로 따른다. 구현 기준은 `react-arborist` v3.5.0이다.

- 행 높이: `22px`
- depth indent: depth당 `8px`
- indent guide: `1px`
- virtualization: 1만+ 파일을 전제로 한다.
- selected row는 focus 상태와 unfocus 상태를 분리해 표시한다.
- inline create/rename은 FileTreePanel 내부로 scope한다.
- keyboard tree navigation은 FileTreePanel 내부로 scope한다.
- delete는 explicit confirmation을 요구한다.

Toolbar의 시각·아이콘 사양은 [design-components.md](./design-components.md)의 FileTreePanel 섹션만 따른다.

## Multi-select

File tree multi-select는 다음 입력을 지원한다.

- `Cmd+click`: 개별 toggle
- `Shift+click`: range selection
- `Cmd+A`: 현재 폴더 내 전체 선택, recursive 아님
- `Esc`: 선택 해제

## Context menu

Context menu는 file, folder, empty context를 구분한다. 파일 기준 메뉴는 다음 계열을 포함한다.

- open 계열: open, open to side
- reveal 계열: reveal in Finder, open in terminal
- search 계열: find in folder
- clipboard 계열: cut, copy, paste, copy path
- mutation 계열: rename, delete
- compare/source control 계열: compare with selected, source control action

Radix/shadcn 기본 role을 유지한다.

Editor tab context menu는 close/copy/reveal/split 계열에 더해 `Move to Floating Window`(`부동 창으로 분리`)를 제공한다. 이 항목은 활성 탭을 flexlayout floating panel로 분리하며, 기본 단축키는 없다.

## Drag and drop

File tree drag-and-drop은 세 상태를 가진다.

- over
- insert
- invalid

지원 범위는 cross-pane open, Finder 외부 in/out, 동일 path 충돌 시 replace modal이다.

Dock/grid drag는 [design-layout.md](./design-layout.md)의 flexlayout adoption criteria로 검증한다.

## ARIA

- Workspace strip: `role="tablist"`, `aria-orientation="vertical"`
- Workspace row: `role="tab"`, `aria-selected`
- Side Bar content: 활성 workspace 또는 Activity Bar view에 연결된 `role="tabpanel"`
- File tree root: multi-select 지원 시 `aria-multiselectable="true"`
- File tree row: 선택 상태를 `aria-selected`로 노출
- Center editor/terminal/diff region: 각각 `role="region"`과 구체적 `aria-label`
- Diff tab root: `aria-label="Diff: {path1} versus {path2}"`
- Split divider: `role="separator"`, 방향별 `aria-orientation`

Resizer keyboard step은 `16px`이다.
