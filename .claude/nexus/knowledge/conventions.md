<!-- tags: conventions, patterns, naming, structure, style -->
# Conventions

## 디렉토리 구조

```
src/
├── main/               # Electron Main Process
│   ├── index.ts         # 진입점 (94줄, 모듈 조립 + BrowserWindow)
│   ├── logger.ts        # electron-log 설정
│   ├── control-plane/   # CLI 통신 모듈 (RunManager, StreamParser, HookServer 등)
│   ├── ipc/             # IPC 핸들러 (handlers.ts, IpcDeps DI 패턴)
│   └── plugin-host/     # 플러그인 시스템 (index.ts, loader.ts)
├── preload/             # contextBridge (단일 파일)
├── renderer/            # React UI
│   ├── components/      # 기능별 그룹: chat/, history/, layout/, permission/, plugins/, settings/, ui/, workspace/
│   ├── stores/          # Zustand 스토어 (기능별 분리)
│   ├── lib/             # 유틸리티 (utils.ts — cn 함수)
│   ├── App.tsx          # 루트 컴포넌트
│   ├── main.tsx         # React 엔트리
│   ├── ipc-bridge.ts    # IPC 이벤트 구독 중앙화
│   └── app.css          # Tailwind v4 CSS (@import "tailwindcss" 단일 줄)
└── shared/              # Main/Renderer 공유 타입 및 IPC 상수
    ├── types.ts         # 모든 IPC 타입, 이벤트 타입, Window 확장
    └── ipc.ts           # 채널명 상수 객체 (as const)
```

## 네이밍

- **파일명**: kebab-case (`run-manager.ts`, `session-store.ts`)
- **컴포넌트**: PascalCase 함수 컴포넌트 (`export function ChatPanel()`)
- **스토어**: `use{Feature}Store` 패턴 (`useSessionStore`, `useStatusBarStore`)
- **IPC 채널**: `namespace:action` 패턴 (`ipc:start`, `stream:text-chunk`, `plugin:data`)
- **타입**: PascalCase, Request/Response/Event 접미사 (`StartRequest`, `TextChunkEvent`)

## 코드 패턴

### IPC 통신
- 채널명은 `src/shared/ipc.ts`의 `IpcChannel` 상수 객체에서만 정의
- 타입은 `src/shared/types.ts`에서 인터페이스로 정의
- Main: `ipc/handlers.ts`에서 `IpcDeps` 인터페이스로 의존성 주입받아 등록
- Renderer: `window.electronAPI.invoke<ResponseType>(IpcChannel.XXX, request)` 패턴
- Stream 이벤트: `ipc-bridge.ts`에서 중앙화 구독, Zustand 스토어에 연결

### 상태 관리
- Zustand `create` + 단일 스토어 슬라이스 패턴
- 액션은 스토어 내부에 정의 (`set`, `get` 사용)
- 셀렉터 훅으로 필요한 상태만 구독: `useStore((s) => s.field)`

### Main Process
- EventEmitter 기반 모듈 통신 (RunManager, StreamParser, HookServer)
- `satisfies` 키워드로 이벤트 타입 안전성 확보
- declare interface로 이벤트 타입 오버로드 선언

### Renderer
- 컴포넌트는 named export 함수형 (`export function ComponentName()`)
- 반환 타입 생략 (React 19에서 글로벌 JSX 네임스페이스 제거됨)
- shadcn/ui 컴포넌트는 `cn()` 유틸 사용 (`src/renderer/lib/utils.ts`)
- 한글 UI 텍스트 (placeholder, label, 상태 메시지)
- 대화 영역에서 특정 도구 필터링: `HIDDEN_TOOLS` Set (TodoWrite, AskUserQuestion)

## 스타일링

- Tailwind CSS v4: `@import "tailwindcss"` 만으로 동작, 별도 config 없음
- 다크 테마 고정: `bg-gray-950` 배경, `text-white`/`text-gray-*` 텍스트
- shadcn/ui 컴포넌트: `cn()` 유틸로 조건부 클래스 조합 (clsx + tailwind-merge)
- 일반 컴포넌트: 배열 + `.join(' ')` 또는 직접 작성