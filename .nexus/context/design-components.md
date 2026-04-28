Responsibility: 반복 UI 컴포넌트의 구체 rendering 규칙을 정의하고, tokens/layout/interactions의 사양을 중복하지 않는다.

# Design Components

## 연결 문서

- 정체성·금지선: [design.md](./design.md)
- 토큰과 아이콘 기준: [design-tokens.md](./design-tokens.md)
- 배치와 panel 구조: [design-layout.md](./design-layout.md)
- keyboard/ARIA 동작: [design-interactions.md](./design-interactions.md)
- renderer 경계: [design-architecture.md](./design-architecture.md)

## FileTreePanel toolbar

FileTreePanel toolbar는 Explorer header 우측 끝의 inline icon-only action group이다. 기존 `grid-cols-2` 텍스트 버튼 row는 사용하지 않는다. 모든 action은 아래 Component height references의 icon button primitive를 쓰는 ghost button이다.

| 액션 | 아이콘 |
|---|---|
| New File | `FilePlus` |
| New Folder | `FolderPlus` |
| Refresh | `RefreshCw` |
| Collapse All | `ChevronsDownUp` |

각 action은 Radix Tooltip과 `aria-label`을 모두 가진다. tooltip은 visual discovery용이고 `aria-label`은 screen reader 이름이다. 텍스트 라벨은 header 내부에 상시 노출하지 않는다.

## Empty state

모든 panel empty state는 같은 4단 구조를 사용한다.

1. 24px stroke icon, `muted-foreground`
2. `text-sm font-medium` 제목
3. `text-xs text-muted-foreground` 한 줄 설명
4. 조건부 `Button sm` 또는 `<kbd>` hint

패널별 문구는 다음 표를 기준으로 한다.

| 표면 | 아이콘 | 제목 | 설명/액션 |
|---|---|---|---|
| Workspace | `FolderOpen` | No workspace open | `Open folder` + `Cmd+O` |
| Terminal | `SquareTerminal` | Open workspace to start terminal | 설명만 |
| File tree / no workspace | `FolderOpen` | No workspace selected | Open a workspace to browse files |
| File tree / empty folder | `Folder` | No files | Create a file or folder in `{workspace}` to begin editing |
| Tool | `Wrench` | Agent tool invocations appear here | 설명만 |
| Session | `History` | No session history | 설명만 |
| Source Control | `GitBranch` | No source changes | 설명만 |
| Preview | `Eye` | Preview unavailable | 설명만 |
| Search | `Search` | Search this workspace with Cmd+Shift+F | kbd hint |
| Output | `SquareTerminal` | No output yet | 설명만 |
| Problems | `GitBranch` | No problems | 설명만 |

아이콘은 장식이므로 `aria-hidden`을 사용한다. 제목은 screen reader anchor가 된다. 버튼 텍스트는 `Open folder`처럼 구체적으로 작성한다.

## Tool call highlight

하네스가 tool을 호출할 때 해당 terminal 영역에 subtle highlight를 적용한다.

- 전체 block wrapper를 만들지 않는다.
- 텍스트 흐름을 가리지 않는다.
- 최소 범위의 배경색 변화만 허용한다.
- 상태·색 선택은 [design-tokens.md](./design-tokens.md)의 semantic token을 따른다.

## Component height references

반복 primitive 높이는 다음 기준을 따른다.

| Primitive | 기본 |
|---|---|
| Button | `h-8` / 32px |
| Tab | `h-9` / 36px |
| Checkbox | 16px |
| Icon button | 28px |

패널·zone의 폭과 dock 구조는 [design-layout.md](./design-layout.md)만 정의한다.
