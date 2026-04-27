# 기술 스택

>> 현재 구현 상태는 roadmap.md를 참조하세요.

## Electron 앱 (TypeScript)

**런타임 및 번들러**: Electron (Chromium 내장). 패키지 관리와 스크립트 실행은 Bun을 사용한다. main·preload·renderer 3축 빌드는 `electron-vite`(alex8088)로 통합한다. 기존 `electron-builder.yml`(asarUnpack·extraResources·mac target)은 그대로 유지하며 electron-vite와 공존시킨다.

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

**UI 레이어**: React + shadcn-style 컴포넌트 + Tailwind CSS. 상태 관리는 Zustand. 앱 셸은 좌 activity bar + 좌 workspace/filetree 패널 + 중앙 terminal/editor 영역 + 우 shared panel의 4열 layout container를 갖는다. 중앙 영역은 Editor/Terminal 모드를 전환하며, 숨겨진 terminal surface는 mount 상태를 유지한다.

**에디터**: Monaco Editor **0.55.1**. renderer는 Node 파일 시스템과 언어 서버에 직접 접근하지 않고, preload의 editor API를 통해 Electron main의 파일/LSP 브리지와 통신한다. 파일트리 CRUD/watch/git 뱃지와 탭 기반 편집, dirty/save/close, Monaco find/replace, LSP 진단 마커를 제공한다.

**LSP 진단 브리지**: Electron main의 LSP bridge가 PATH에서 언어 서버를 찾아 stdio JSON-RPC로 best-effort diagnostics를 수집한다. 명령이 없으면 해당 서버 상태를 unavailable로 보고한다. 명령은 다음으로 고정한다.

- TypeScript: `typescript-language-server --stdio`
- Python: `pyright-langserver --stdio`
- Go: `gopls serve`, 실패 시 `gopls`

sidecar-owned full languageclient는 장기 구조의 별도 책임으로 둔다.

**터미널**: xterm.js + WebGL 렌더러 애드온. PTY는 Electron main 프로세스의 node-pty로 관리한다. renderer는 PTY 데이터를 IPC로 받아 xterm.js로 표시한다. renderer는 `@xterm/xterm/css/xterm.css`를 import하고, `allowProposedApi: true`, workspace별 `cwd`, focus repair, visibility 변경 시 WebGL texture atlas clear + full refresh repair를 적용한다.

에디터·터미널 런타임 고정 버전은 다음과 같다.

- `monaco-editor` **0.55.1**
- `@xterm/xterm` **6.0.0**
- `@xterm/addon-webgl` **0.19.0**
- `@xterm/addon-fit` **0.11.0**
- `@xterm/addon-search` **0.16.0**
- `@xterm/addon-unicode11` **0.9.0**
- `node-pty` **1.1.0**

**xterm 핀 정책 (Issue 4 반영)**

- xterm 코어/애드온은 semver range(`^`, `~`)를 쓰지 않고 **정확 버전 pin**만 허용한다.
- 코어와 애드온은 한 묶음으로 올린다. 일부 패키지만 단독 업그레이드하지 않는다.
- 분기마다 upstream 이슈 점검 기준은 `.nexus/memory/external-xterm-js.md`를 따른다.

**기본 폰트 번들 (OFL 1.1)**

- `assets/fonts/d2coding/*` (D2Coding regular/bold + `OFL.txt`)
- `assets/fonts/noto-sans-kr/*` (Noto Sans KR variable + `OFL.txt`)
- 기본 스택: `"D2Coding", "Noto Sans KR", ui-monospace, ...`

**Git (앱 레이어)**: main 프로세스에서 git CLI를 `execFile`로 호출한다. 파일트리 git 뱃지는 `git status --porcelain=v1 --untracked-files=all` 결과를 workspace-relative path에 매핑한다.

**마크다운**: react-markdown + remark/rehype 플러그인 체인.

**웹뷰 프리뷰**: Electron WebContentsView (sandbox: true). localhost 개발 서버와 정적 URL을 에디터 옆 패널에서 표시한다.

**패키징**: electron-builder 설정은 유지한다. `extraResources`에는 node-pty 네이티브 바이너리(`pty.node`)와 OFL 폰트 번들이 포함된다. v0.1 로드맵은 signed/codesigned/notarized 앱 QA를 내부 게이트로 두지 않는다. `package:mac`는 스크립트로 남아 있으나 사용자 외부 작업 영역이다.

## Go Sidecar

**언어**: Go. 워크스페이스당 하나씩 독립 프로세스로 실행되는 장기 실행 데몬이다.

**PTY 감독**: creack/pty. sidecar가 spawn하는 AI 하네스 등 자식 프로세스의 PTY를 관리한다. 터미널 탭 PTY(node-pty)와는 별개다. LSP 서버 감독은 장기 sidecar 의도이며, 터미널 탭 PTY 감독과 별도의 책임 영역이다.

**파일 시스템 감시**: sidecar 장기 구조는 fsnotify를 사용한다. 파일트리 watch는 Electron main의 파일 bridge가 Node `fs.watch`를 best-effort로 사용하며, IPC 파일 CRUD는 결정적 watch 이벤트를 별도로 emit한다.

**WebSocket IPC**: `github.com/coder/websocket` v1.8.14를 사용한다. facade 패턴(`sidecar/internal/wsx/`)으로 격리하여 향후 교체 시 영향 범위를 제한한다. 자세한 선택 근거와 운영 정책은 `.nexus/memory/external-coder-websocket.md`를 따른다.

**Git (sidecar 레이어)**: 장기 구조에서는 go-git 또는 os/exec git CLI가 워크스페이스 git 상태, 브랜치, diff 연산을 처리한다. 파일트리 git 뱃지의 앱 경로는 Electron main의 git CLI가 담당한다.

**LSP pass-through**: 장기 sidecar 소유 의도는 표준 encoding/json으로 언어 서버와 에디터 사이의 JSON-RPC 메시지를 중계하는 것이다. 앱의 MVP 진단 경로는 Electron main의 best-effort diagnostics 브리지다.

## IPC 타입 계약

Electron main(TypeScript)과 Go sidecar 사이의 메시지 타입은 JSON schema를 단일 진실 소스로 사용한다. `schema/` 디렉터리가 원본이며, TS는 `json-schema-to-typescript`로 자동 생성하고 Go는 수작업으로 동기화한다. 생성물과 원본 간 불일치는 CI drift gate가 차단한다.

## Codegen 도구 묶음

JSON schema 기반 codegen과 유효성 검사를 담당하는 도구 묶음이다. 전체를 한 세트로 관리하며 일부만 단독 업그레이드하지 않는다.

- `json-schema-to-typescript` **15.0.4** (bcherny, MIT) — schema → TS 인터페이스/타입 별칭 생성
- `ajv` **8.20.0** — JSON schema 유효성 검사 (2020 draft)
- ~~`ajv-cli` **5.0.0**~~ — plan #16 H1에서 폐기. electron-vite ESM 환경에서 CJS standalone 출력이 런타임 실패하므로 facade에서 Ajv 런타임 컴파일로 전환. `scripts/gen-contracts.ts`에서 ajv-cli 호출 및 `generated/*.validate.ts` 산출물 모두 제거됨.
- `ajv-formats` **3.0.1** — `format` 키워드 지원

**묶음 업그레이드 정책**: 분기 1회 또는 보안 패치 시 전체 묶음을 함께 점검한다. xterm 묶음·Electron 런타임 묶음과 동일한 모델을 적용한다. semver range(`^`, `~`) 사용 금지.

Go 측은 수작업 유지한다. `atombender/go-jsonschema` 등은 현재 품질 기준 미달로 미설치하며, 향후 도구 성숙 시 PoC를 재시도할 수 있다. Go 수작업 코드의 drift는 `.github/workflows/contracts-drift.yml`과 `scripts/check-go-contracts-drift.sh`로 검증한다.

## WebSocket 묶음

sidecar ↔ main 간 IPC와 관련된 WebSocket 라이브러리 묶음이다. Go 측과 TS 측을 한 세트로 관리한다.

- `github.com/coder/websocket` **v1.8.14** (ISC) — Go sidecar 서버·클라이언트
- `ws` **8.18.0** (MIT) — Electron main 측 WebSocket 클라이언트
- `@types/ws` **8.5.x** — `ws`용 TypeScript 타입 정의

**묶음 업그레이드 정책**: 분기 1회 또는 보안 패치 시 전체 묶음을 함께 점검한다. Go 측 라이브러리 교체는 facade 격리 원칙 하에 진행하며, 교체 시 영향 범위는 `sidecar/internal/wsx/`와 `packages/app/src/main/sidecar-bridge/`로 한정된다.

**차안 유효성 재확인**: 12개월마다 `gorilla/websocket` v1.5.3을 대안으로 재평가한다. 차안 발동 조건은 `coder/websocket` v2 강제 마이그레이션 압력 또는 CVE 미패치다.

**Go 버전 동기**: `coder/websocket` v1.8.14의 `go.mod`가 Go 1.23을 요구함에 따라 sidecar `go.mod`를 1.23으로 올리고 toolchain은 `go1.24.3`으로 자동 갱신되었다.

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
| Integration 하네스 테스트(IME + runtime terminal) | `cd packages/app && bun run test:integration` |
| xterm 폰트 번들 검증 테스트 | `cd packages/app && bun run test:fonts` |
| macOS 디렉터리 패키징 | `cd packages/app && bun run package:dir` |
| macOS 패키징 스크립트(v0.1 내부 게이트 아님) | `cd packages/app && bun run package:mac` |
| Go sidecar 빌드 | `cd sidecar && mkdir -p bin && go build -o bin/nexus-sidecar ./cmd/nexus-sidecar` |
| Go sidecar 테스트 | `cd sidecar && go test ./...` |

빌드는 Go 도구 체인과 Bun이 모두 설치된 환경을 전제한다.

## 관리 리스크 (스택 레벨)

아래 항목은 구현 전에 선제적으로 확인해야 하는 알려진 위험이다.

- xterm.js IME composing 오버레이 이슈 — composingstart/end 오버레이 패치로 회피 계획. 한국어 입력 품질에 직접 영향.
- node-pty와 Electron 최신 버전 간 호환성 — 매 Electron 메이저 업그레이드마다 prebuilt binary 재빌드 필요.
- IPC 계약 드리프트 — TypeScript와 Go 타입이 어긋나지 않도록 코드 생성 파이프라인과 drift gate를 유지한다.
- macOS codesign + notarization — v0.1 로드맵 내부 게이트가 아니라 사용자 외부 작업 영역. 내부 문서는 unsigned dev launch와 자동/수동 기능 검증을 기준으로 유지한다.
