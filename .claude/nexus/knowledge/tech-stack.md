<!-- tags: tech-stack, dependencies, versions, build, vite, electron -->
# Tech Stack

## Core

| 패키지 | 버전 | 역할 |
|--------|------|------|
| electron | ^41.0.0 | 데스크톱 런타임 (Chromium) |
| electron-vite | ^5.0.0 | Main/Preload/Renderer 3분할 빌드 |
| vite | ^7.0.0 | 번들러 |
| react | ^19.0.0 | UI 프레임워크 |
| react-dom | ^19.0.0 | DOM 렌더링 |
| typescript | ~5.9.3 | 타입 시스템 |

## Frontend

| 패키지 | 버전 | 역할 |
|--------|------|------|
| tailwindcss | ^4.0.0 | CSS-first 스타일링 (v4, config 파일 불필요) |
| @tailwindcss/vite | ^4.0.0 | Tailwind Vite 플러그인 |
| zustand | ^5.0.0 | 경량 상태 관리 |
| react-markdown | ^10.1.0 | 마크다운 렌더링 |
| remark-gfm | ^4.0.1 | GFM 마크다운 확장 |
| react-syntax-highlighter | ^15.6.1 | 코드 구문 강조 (PrismLight + oneDark) |
| lucide-react | ^0.487.0 | 아이콘 |
| @ark-ui/react | ^5.0.0 | 보조 UI (Tree 등 shadcn 미지원 컴포넌트) |

## shadcn/ui 관련

| 패키지 | 역할 |
|--------|------|
| @radix-ui/react-collapsible | Collapsible 프리미티브 |
| class-variance-authority | 컴포넌트 variant 관리 |
| clsx | 조건부 클래스 결합 |
| tailwind-merge | Tailwind 클래스 충돌 해결 |

현재 사용 중인 shadcn 컴포넌트: **button**, **badge**, **card**, **collapsible** (`src/renderer/components/ui/`)

## Build & Dev

| 패키지 | 버전 | 역할 |
|--------|------|------|
| @vitejs/plugin-react-swc | ^4.3.0 | SWC 기반 React 변환 (Vite 4~8 호환) |
| @electron-toolkit/preload | ^3.0.0 | Electron preload 유틸리티 |
| @electron-toolkit/utils | ^3.0.0 | Electron 유틸리티 (`is.dev` 등) |

## Testing

| 패키지 | 버전 | 역할 |
|--------|------|------|
| @playwright/test | ^1.58.2 | E2E 테스트 |
| playwright | ^1.58.2 | Electron 자동화 |

## Package Manager

**Bun** — 패키지 설치/관리 전용. 런타임은 Electron(Node.js). `bun.lock` 사용.

## Vite 호환성 제약

- electron-vite 5의 peerDep: `vite ^5 || ^6 || ^7` — **vite 8 미지원, v7로 고정**
- `@vitejs/plugin-react` 6.x는 Vite 8 전용 → **plugin-react-swc 4.x** 사용
- `@tailwindcss/vite`는 Vite 5~8 모두 호환

## TypeScript 설정

- `tsconfig.json`: 루트, `tsconfig.node.json`과 `tsconfig.web.json`을 references로 분리
- `tsconfig.node.json`: Main + Preload + Shared. target ES2022, module ESNext
- `tsconfig.web.json`: Renderer + Shared. JSX react-jsx, DOM lib 포함
- Path alias: `@renderer/*` → `./src/renderer/*`, `@shared/*` → `./src/shared/*`

## UI 구성

- **shadcn/ui** (components.json 설정 존재): 컴포넌트 소유 모델, `npx shadcn add` 방식. 현재 button, badge, card, collapsible 4개 컴포넌트 사용
- **Ark UI**: shadcn 미지원 컴포넌트(Tree 등) 보완
- **디자인 방향**: 다크 테마(gray-950 배경), 미니멀 클린. StatusBar로 대화 외 상호작용(TodoWrite, AskUserQuestion) 분리