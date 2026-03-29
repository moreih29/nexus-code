<!-- tags: tech-stack, dependencies, build, typescript -->
# Tech Stack

## 핵심 의존성

| 패키지 | 버전 | 역할 |
|--------|------|------|
| electron | ^41.0.0 | 데스크톱 런타임 |
| electron-vite | ^5.0.0 | 3분할 빌드 (main/preload/renderer) |
| vite | ^7.0.0 | 번들러 (electron-vite peerDep, v8 미지원) |
| react | ^19.0.0 | UI 프레임워크 |
| react-dom | ^19.0.0 | DOM 렌더링 |
| typescript | ~5.9.3 | 타입 시스템 (strict mode) |
| tailwindcss | ^4.0.0 | CSS 프레임워크 (v4 CSS-first) |
| zustand | ^5.0.0 | 상태 관리 |
| react-resizable-panels | ^4.7.6 | 리사이저블 패널 레이아웃 |
| lucide-react | ^0.487.0 | 아이콘 |
| cmdk | ^1.1.1 | 커맨드 팔레트 |
| react-markdown + remark-gfm | ^10.1.0 | 마크다운 렌더링 |
| react-syntax-highlighter | ^16.1.1 | 코드 구문 강조 |
| @ark-ui/react | ^5.0.0 | 보조 UI (Tree 등) |
| electron-log | ^5.4.3 | 구조화 로깅 |

## 빌드/개발

| 도구 | 역할 |
|------|------|
| Bun | 패키지 매니저 (런타임은 Node.js) |
| @vitejs/plugin-react-swc | SWC 기반 React 변환 |
| @tailwindcss/vite | Tailwind Vite 플러그인 |
| @playwright/test | E2E 테스트 |

## TypeScript 설정

- `tsconfig.json`: 프로젝트 레퍼런스 (`tsconfig.node.json` + `tsconfig.web.json`)
- `tsconfig.node.json`: Main + Preload
- `tsconfig.web.json`: Renderer
- Path alias: `@renderer` → `src/renderer`, `@shared` → `src/shared`

## 주의사항

- **Vite 버전**: electron-vite가 vite ^7까지만 지원. v8 사용 불가.
- **react-resizable-panels 크기 지정**: number = px, string = % (e.g., `defaultSize="18%"` vs `defaultSize={200}`)