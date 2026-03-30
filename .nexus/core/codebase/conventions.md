<!-- tags: conventions, code-style, naming, patterns, ipc -->
# Conventions

## 코드 스타일

- **TypeScript strict mode** 전체 적용
- **파일명**: kebab-case (`run-manager.ts`, `session-store.ts`)
- **컴포넌트**: PascalCase 함수 컴포넌트 (`export function ChatPanel()`)
- **인터페이스**: PascalCase (`StartRequest`, `StartResponse`)
- **상수**: UPPER_SNAKE_CASE 또는 PascalCase 객체 (`IpcChannel`, `COLLAPSED_SIZE`)

## React 패턴

- 함수 컴포넌트 전용 (클래스 컴포넌트 없음)
- Zustand 스토어로 전역 상태 관리 (`create<T>()`)
- IPC 이벤트 리스너는 `useEffect`에서 등록/해제
- Props 인터페이스는 컴포넌트 파일 내 정의

## CSS/스타일

- Tailwind CSS v4 (CSS-first, config 파일 없음)
- 다크 테마 전용 (`bg-background`, `text-foreground`)
- CSS 변수 기반 테마 (`--background`, `--foreground`, `--primary` 등)
- `cn()` 유틸로 클래스 병합 (clsx + tailwind-merge)

## IPC 통신

- 채널명: `ipc:` 접두사 (request-response), `stream:` 접두사 (이벤트)
- 타입: `src/shared/types.ts`에 Request/Response 쌍으로 정의
- 채널 상수: `src/shared/ipc.ts`의 `IpcChannel` 객체
- **타입 매핑**: `IpcMap` 타입으로 채널-페이로드 자동 추론. `invoke<제네릭>` 수동 지정 금지.
- **새 IPC 채널 추가 시**: IpcChannel 상수 추가 → Request/Response 타입 정의 → IpcMap에 매핑 추가 → handler 구현
- **void 채널**: req가 `void`인 채널은 인자 없이 `invoke(IpcChannel.XXX)` 호출

## UI 텍스트

- 한글 UI 텍스트 기본 (버튼, 레이블, 안내 메시지)
- 기술 용어는 영문 유지 (Workspace, Session, Checkpoint 등)

## Git 커밋

- 형식: `{type}: {scope} — {description}`
- 예: `feat: Phase 4 레이아웃 리팩토링 — 리사이저블 패널 + 아이콘 스트립`
- 브랜치: `feat/{scope}`, `fix/{scope}`, `chore/{scope}`