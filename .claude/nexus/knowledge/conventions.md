<!-- tags: conventions, patterns, naming, structure, style -->
<!-- tags: conventions, patterns, naming, structure -->
# Conventions

## 디렉토리 구조

```
src/
├── main/           # Electron Main Process 모듈 (flat, 서브디렉토리 없음)
├── preload/        # contextBridge (단일 파일)
├── renderer/       # React UI
│   ├── components/ # 기능별 그룹: chat/, history/, layout/, permission/, plugins/, settings/, workspace/
│   ├── stores/     # Zustand 스토어 (기능별 분리)
│   ├── App.tsx     # 루트 컴포넌트
│   ├── main.tsx    # React 엔트리
│   └── app.css     # Tailwind v4 CSS (@import "tailwindcss" 단일 줄)
└── shared/         # Main/Renderer 공유 타입 및 IPC 상수
    ├── types.ts    # 모든 IPC 타입, 이벤트 타입, Window 확장
    └── ipc.ts      # 채널명 상수 객체 (as const)
```

## 네이밍

- **파일명**: kebab-case (`run-manager.ts`, `session-store.ts`)
- **컴포넌트**: PascalCase 함수 컴포넌트 (`function ChatPanel(): JSX.Element`)
- **스토어**: `use{Feature}Store` 패턴 (`useSessionStore`, `usePluginStore`)
- **IPC 채널**: `namespace:action` 패턴 (`ipc:start`, `stream:text-chunk`, `plugin:data`)
- **타입**: PascalCase, Request/Response/Event 접미사 (`StartRequest`, `TextChunkEvent`)

## 코드 패턴

### IPC 통신
- 채널명은 `src/shared/ipc.ts`의 `IpcChannel` 상수 객체에서만 정의
- 타입은 `src/shared/types.ts`에서 인터페이스로 정의
- Main: `ipcMain.handle(IpcChannel.XXX, handler)` 패턴
- Renderer: `window.electronAPI.invoke<ResponseType>(IpcChannel.XXX, request)` 패턴
- Stream 이벤트: `window.electronAPI.on/off(IpcChannel.XXX, handler)` + useEffect 클린업

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
- JSX.Element 반환 타입 명시
- Tailwind 클래스 직접 작성 (유틸 함수 없이)
- 한글 UI 텍스트 (placeholder, label, 상태 메시지)

## 스타일링

- Tailwind CSS v4: `@import "tailwindcss"` 만으로 동작, 별도 config 없음
- 다크 테마 고정: `bg-gray-950` 배경, `text-white`/`text-gray-*` 텍스트
- 클래스 조합 시 배열 + `.join(' ')` 패턴 (cn 유틸 미사용)
