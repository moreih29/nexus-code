Responsibility: nexus-code의 색·타이포그래피·아이콘·기본 치수 토큰을 정의하고, 레이아웃·컴포넌트 문서는 이 값을 참조만 한다.

# Design Tokens

## 연결 문서

- 철학과 금지선: [design.md](./design.md)
- 레이아웃 치수 적용: [design-layout.md](./design-layout.md)
- 컴포넌트별 사용처: [design-components.md](./design-components.md)
- renderer 경계와 테스트 정책: [design-architecture.md](./design-architecture.md)

## 토큰 구현 방식

Tailwind v4 CSS-first 문법을 채택한다. `packages/app/src/renderer/styles.css`는 `@import "tailwindcss"`와 `@theme` 블록을 기준으로 하며, content 경로는 CSS의 `@source`로 관리한다. `@tailwindcss/postcss`와 `autoprefixer` 구성은 유지한다.

프리미티브 베이스는 Tailwind `zinc`다. 블루 틴트 없는 쿨 그레이를 기본으로 사용하고, 프로젝트는 프리미티브 재정의가 아니라 semantic token 정의에 집중한다.

## Accent

Accent는 **Terminal Teal**이다.

- 값: `oklch(0.70 0.10 195)`
- 16진 근사: `#3aa0a6`
- chroma 운용 범위: `0.08~0.12`
- 사용 원칙: VS Code blue와 Cursor 계열 purple을 피하고, 터미널 전통 청록과 연결한다.

이 색은 workbench accent다. active/focus 표시 정책은 [design-layout.md](./design-layout.md)를 따른다.

## Semantic token set

shadcn 명칭 체계를 수용한다.

- 기본: `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `primary`, `primary-foreground`, `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `destructive`, `destructive-foreground`, `border`, `input`, `ring`
- sidebar 확장: `sidebar`, `sidebar-foreground`, `sidebar-border`
- 하네스 상태 확장: `status-running`, `status-attention`
- completed 상태는 별도 색을 만들지 않고 무뱃지로 접는다.

```css
@import "tailwindcss";
@theme {
  --color-background: var(--color-zinc-950);
  --color-foreground: var(--color-zinc-50);
  --color-card: var(--color-zinc-900);
  --color-card-foreground: var(--color-zinc-50);
  --color-primary: oklch(0.70 0.10 195);
  --color-primary-foreground: var(--color-zinc-950);
  --color-secondary: var(--color-zinc-800);
  --color-secondary-foreground: var(--color-zinc-50);
  --color-muted: var(--color-zinc-800);
  --color-muted-foreground: var(--color-zinc-400);
  --color-accent: var(--color-zinc-800);
  --color-accent-foreground: var(--color-zinc-50);
  --color-destructive: var(--color-red-500);
  --color-border: var(--color-zinc-800);
  --color-input: var(--color-zinc-800);
  --color-ring: oklch(0.70 0.10 195);
  --color-sidebar: var(--color-zinc-950);
  --color-sidebar-foreground: var(--color-zinc-300);
  --color-sidebar-border: var(--color-zinc-800);
  --color-status-running: oklch(0.75 0.12 150);
  --color-status-attention: oklch(0.78 0.12 75);
  --radius: 0.5rem;
}
```

MVP는 dark mode 단일이다. light mode는 v0.2에서 semantic token remap으로 확장한다.

## Monaco bridge

Monaco `defineTheme`은 hex 값을 사용한다. `MonacoEditorHost`는 `nexus-dark`를 고정 hex theme으로 정의하고, CSS oklch token을 Monaco에 직접 전달하지 않는다. 필요한 경우 CSS token에서 hex로 변환하는 bridge를 별도 adapter로 둔다.

## Typography

UI sans와 xterm font는 의도적으로 분리한다.

- UI sans: `"Inter"`, `"Pretendard Variable"`, `"Pretendard"`, `ui-sans-serif`, `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `"Apple SD Gothic Neo"`, `"Malgun Gothic"`, `"Segoe UI"`, `sans-serif`
- UI mono: `"JetBrains Mono"`, `"D2Coding"`, `"Pretendard Variable"`, `ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`, `Consolas`, `"Liberation Mono"`, `"Courier New"`, `monospace`
- xterm: 기존 `--nx-terminal-font-family`를 유지하며 한국어 정렬 품질을 최우선으로 둔다.

크기 스케일은 `xs 11px`, `sm 12px`, `base 13px`, `md 14px`, `lg 16px`, `xl 20px`, `2xl 24px`다. 행높이는 `tight 1.25`, `normal 1.45`, `relaxed 1.6` 세 단계다.

기본 font feature는 ligature off, tabular number off다. 숫자 정렬이 필요한 상태바·테이블·진행률·터미널 탭 번호에만 `.nx-tabular`를 적용한다. Inter에는 `"cv11"`과 `"ss01"`을 적용한다.

## Icon system

기본 아이콘 시스템은 `lucide-react`다.

- stroke width: `1.75`
- 기본 크기: `16px`
- 주요 chrome action 최대 크기: `20px`
- 파일 타입 식별: `vscode-icons-js` lazy SVG를 사용하되, 철학 문서의 컬러 아이콘 금지선을 따른다.

고정 매핑은 다음과 같다.

| 의미 | 아이콘 |
|---|---|
| close | `X` |
| add | `Plus` |
| folder | `Folder` / `FolderOpen` |
| search | `Search` |
| git | `GitBranch` |
| terminal | `SquareTerminal` |
| command | `Command` |
| settings | `Settings` |
| chevron | `ChevronRight` / `ChevronDown` |
| split | `SplitSquareHorizontal` |
| maximize | `Maximize2` / `Minimize2` |
| diff | `GitCompare` |

## Border, radius, spacing

- Border는 `1px` 고정이다.
- Focus ring/outline은 각 표면의 접근성 정책에서만 예외를 허용한다.
- 기준 radius는 `0.5rem`(8px)이다.
- Spacing은 Tailwind 기본 4px 단위를 유지한다.
