# 기술 스택

## Electron 앱 (TypeScript)

**런타임 및 번들러**: Electron (Chromium 내장). 패키지 관리와 스크립트 실행은 Bun을 사용한다. main·preload·renderer 3축 빌드는 `electron-vite`(alex8088)로 통합한다(plan #4 Issue 3). 기존 `electron-builder.yml`(asarUnpack·extraResources·mac target)은 그대로 유지하며 electron-vite와 공존시킨다.

**정확 pin 정책 확장**: 아래 패키지는 xterm과 동일한 "정확 버전 pin + 일괄 업그레이드" 원칙을 따른다. semver range(`^`, `~`) 사용 금지. Electron 앱 런타임 세트(`electron-vite`/`vite`/React/Zustand/Tailwind)는 호환성 검증 단위가 같으므로 일부만 단독 업그레이드하지 않는다.

- `electron-vite` **5.0.0**
- `vite` **7.3.2**
- `@vitejs/plugin-react` **5.2.0**
- `react` / `react-dom` **19.2.5**
- `zustand` **5.0.12**
- `tailwindcss` / `@tailwindcss/postcss` **4.2.4**

**Renderer → node-pty 차단 4중 방어**: renderer 번들에 node-pty가 혼입되는 사고를 원천 차단한다.

1. main `rollupOptions.external = ['node-pty']`
2. renderer `resolve.alias`로 `node-pty`를 강제 오류로 재작성
3. ESLint `no-restricted-imports`로 `src/renderer/**` → `node-pty` import 금지
4. 회귀 smoke: renderer 번들에서 node-pty import 시도 시 빌드 실패 케이스 유지

**Dev 스크립트 prefix**: Bun + Go sidecar 빌드 + electron-rebuild + electron-vite dev 서버 경합 회피. `"dev": "bun run build:sidecar && bun run rebuild:native && electron-vite dev"` 형태를 강제한다. CI는 `bun install --frozen-lockfile` 이후 `build:sidecar`와 `rebuild:native` 성공을 gate로 요구한다.

현재 `packages/app` Electron 실행 스크립트의 핵심 형태는 다음으로 고정한다.

- `build:sidecar`: `cd ../../sidecar && mkdir -p bin && go build -o bin/nexus-sidecar ./cmd/nexus-sidecar`
- `dev`: `bun run build:sidecar && bun run rebuild:native && electron-vite dev`
- `build`: `electron-vite build`
- `start`: `bun run build && electron-vite preview`
- `preview`: `electron-vite preview`

**UI 레이어**: React + shadcn-style 컴포넌트 + Tailwind CSS. 상태 관리는 Zustand. Phase A 셸은 좌 activity bar + 좌 workspace/filetree 패널 + 중앙 terminal/editor 영역 + 우 shared panel의 4열 layout container를 갖는다.

**에디터**: Monaco Editor + monaco-languageclient. LSP 연결은 WebSocket 프록시를 통해 sidecar가 감독하는 언어 서버에 연결한다.

**터미널**: xterm.js + WebGL 렌더러 애드온. PTY는 Electron main 프로세스의 node-pty로 관리한다. renderer는 PTY 데이터를 IPC로 받아 xterm.js로 표시한다. renderer는 `@xterm/xterm/css/xterm.css`를 import하고, `allowProposedApi: true`, workspace별 `cwd`, focus repair, visibility 변경 시 WebGL texture atlas clear + full refresh repair를 적용한다.

현재 E2 코드 기준 고정 버전은 다음과 같다.

- `@xterm/xterm` **6.0.0**
- `@xterm/addon-webgl` **0.19.0**
- `@xterm/addon-fit` **0.11.0**
- `@xterm/addon-search` **0.16.0**
- `@xterm/addon-unicode11` **0.9.0**
- `node-pty` **1.1.0**

**xterm 핀 정책 (Issue 4 반영)**

- xterm 코어/애드온은 semver range(`^`, `~`)를 쓰지 않고 **정확 버전 pin**만 허용한다.
- 코어와 애드온은 한 묶음으로 올린다. 일부 패키지만 단독 업그레이드하지 않는다.
- 분기마다 `#5734`, `#1453`, `#4753` 상태를 점검하고(`.nexus/memory/external-xterm-js.md`), 필요 시 escape-hatch runbook을 발동한다(`.nexus/memory/pattern-xterm-fork-escape-hatch.md`).

**기본 폰트 번들 (OFL 1.1)**

- `assets/fonts/d2coding/*` (D2Coding regular/bold + `OFL.txt`)
- `assets/fonts/noto-sans-kr/*` (Noto Sans KR variable + `OFL.txt`)
- 기본 스택: `"D2Coding", "Noto Sans KR", ui-monospace, ...`

**Git (앱 레이어)**: simple-git. main 프로세스에서 git 상태 표시 등 UI 연동에 사용한다.

**마크다운**: react-markdown + remark/rehype 플러그인 체인.

**웹뷰 프리뷰**: Electron WebContentsView (sandbox: true). localhost 개발 서버와 정적 URL을 에디터 옆 패널에서 표시한다.

**패키징**: electron-builder 설정은 유지한다. 현재 E2/Phase A 기준 `extraResources`에는 node-pty 네이티브 바이너리(`pty.node`)와 OFL 폰트 번들이 포함된다. 단, plan #4 이후 Phase A와 v0.1 로드맵은 signed/codesigned/notarized 앱 QA를 내부 게이트로 두지 않는다. `package:mac`는 스크립트로 남아 있으나 사용자 외부 작업 영역이다.

## Go Sidecar

**언어**: Go. 워크스페이스당 하나씩 독립 프로세스로 실행되는 장기 실행 데몬이다.

**PTY 감독**: creack/pty. sidecar가 spawn하는 LSP 서버 및 AI 하네스 자식 프로세스의 PTY를 관리한다. 터미널 탭 PTY(node-pty)와는 별개다.

**파일 시스템 감시**: fsnotify. 워크스페이스 내 파일 변경을 감지해 에디터와 하네스 관찰에 활용한다.

**WebSocket IPC**: gorilla/websocket 또는 nhooyr/websocket 중 E3 plan에서 선택한다. Phase A sidecar는 lifecycle-only로 실행·종료만 검증했고, Electron main과의 WebSocket lifecycle handshake는 E3 첫 태스크 묶음으로 이관됐다.

**Git (sidecar 레이어)**: go-git 또는 os/exec git CLI. 워크스페이스 git 상태, 브랜치, diff 연산을 처리한다.

**LSP pass-through**: 표준 encoding/json. 언어 서버와 에디터 사이의 JSON-RPC 메시지를 중계한다.

## IPC 타입 계약

Electron main(TypeScript)과 Go sidecar 사이의 메시지 타입은 protobuf 또는 JSON schema 중 E3 구현 시점에 확정한다. 어느 방식이든 코드 생성 파이프라인으로 양쪽 언어의 타입을 동기화한다. proto/ 또는 schema/ 디렉터리가 단일 진실 소스 역할을 한다.

## 플랫폼 타깃

MVP 타깃은 macOS arm64와 x64다. Go 정적 바이너리의 크로스컴파일 특성상 Windows와 Linux 지원은 MVP 이후 낮은 추가 비용으로 확장 가능하다.

## 빌드 / 테스트 / 배포 명령

현재 확인 가능한 명령은 다음과 같다.

| 목적 | 명령 |
|------|------|
| Electron dev launch (sidecar 빌드 + native rebuild + electron-vite dev) | `cd packages/app && bun run dev` |
| Electron build | `cd packages/app && bun run build` |
| Electron build 후 preview | `cd packages/app && bun run start` |
| 기존 build preview | `cd packages/app && bun run preview` |
| Go sidecar 빌드(app script) | `cd packages/app && bun run build:sidecar` |
| node-pty 재빌드 | `cd packages/app && bun run rebuild:native` |
| node-pty smoke (arm64 자동) | `cd packages/app && bun run verify:native` |
| 네이티브 릴리스 체크리스트 출력 | `cd packages/app && bun run verify:native:checklist` |
| renderer lint | `cd packages/app && bun run lint:renderer` |
| renderer node-pty import guard | `cd packages/app && bun run smoke:renderer-node-pty-guard` |
| Phase A / IME 자동 체크리스트 | `cd packages/app && bun run test:ime-checklist` |
| runtime terminal IPC 테스트 | `cd packages/app && bun run test:runtime-terminal` |
| xterm 폰트 번들 검증 테스트 | `cd packages/app && bun run test:fonts` |
| macOS 디렉터리 패키징 | `cd packages/app && bun run package:dir` |
| macOS 패키징 스크립트(Phase A/v0.1 내부 게이트 아님) | `cd packages/app && bun run package:mac` |
| Go sidecar 빌드 | `cd sidecar && mkdir -p bin && go build -o bin/nexus-sidecar ./cmd/nexus-sidecar` |
| Go sidecar 테스트 | `cd sidecar && go test ./...` |

빌드는 Go 도구 체인과 Bun이 모두 설치된 환경을 전제한다.

## 관리 리스크 (스택 레벨)

아래 항목은 구현 전에 선제적으로 확인해야 하는 알려진 위험이다.

- xterm.js IME 이슈(#5734) — composingstart/end 오버레이 패치로 회피 계획. 한국어 입력 품질에 직접 영향.
- node-pty와 Electron 최신 버전 간 호환성 — 매 Electron 메이저 업그레이드마다 prebuilt binary 재빌드 필요.
- IPC 계약 드리프트 — TypeScript와 Go 타입이 어긋나지 않도록 E3에서 코드 생성 파이프라인과 drift gate를 추가.
- macOS codesign + notarization — Phase A/v0.1 로드맵 내부 게이트가 아니라 사용자 외부 작업 영역. 내부 문서는 unsigned dev launch와 자동/수동 기능 검증을 기준으로 유지한다.
