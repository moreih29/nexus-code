# 기술 스택

## Electron 앱 (TypeScript)

**런타임 및 번들러**: Electron (Chromium 내장). 패키지 관리와 스크립트 실행은 Bun을 사용한다.

**UI 레이어**: React + shadcn/ui + Tailwind CSS. 상태 관리는 Zustand. 컴포넌트 구성과 스타일링의 경계는 이 조합이 정의한다.

**에디터**: Monaco Editor + monaco-languageclient. LSP 연결은 WebSocket 프록시를 통해 sidecar가 감독하는 언어 서버에 연결한다.

**터미널**: xterm.js + WebGL 렌더러 애드온. PTY는 Electron main 프로세스의 node-pty로 관리한다. renderer는 PTY 데이터를 IPC로 받아 xterm.js로 표시한다. VSCode가 확립한 패턴이다.

**Git (앱 레이어)**: simple-git. main 프로세스에서 git 상태 표시 등 UI 연동에 사용한다.

**마크다운**: react-markdown + remark/rehype 플러그인 체인.

**웹뷰 프리뷰**: Electron WebContentsView (sandbox: true). localhost 개발 서버와 정적 URL을 에디터 옆 패널에서 표시한다.

**패키징**: electron-builder. macOS codesign과 notarization을 포함한다. Go sidecar 정적 바이너리도 동일한 서명 파이프라인에 포함된다.

## Go Sidecar

**언어**: Go. 워크스페이스당 하나씩 독립 프로세스로 실행되는 장기 실행 데몬이다.

**PTY 감독**: creack/pty. sidecar가 spawn하는 LSP 서버 및 AI 하네스 자식 프로세스의 PTY를 관리한다. 터미널 탭 PTY(node-pty)와는 별개다.

**파일 시스템 감시**: fsnotify. 워크스페이스 내 파일 변경을 감지해 에디터와 하네스 관찰에 활용한다.

**WebSocket IPC**: gorilla/websocket 또는 nhooyr/websocket. Electron main 프로세스와의 통신 채널을 제공한다.

**Git (sidecar 레이어)**: go-git 또는 os/exec git CLI. 워크스페이스 git 상태, 브랜치, diff 연산을 처리한다.

**LSP pass-through**: 표준 encoding/json. 언어 서버와 에디터 사이의 JSON-RPC 메시지를 중계한다.

## IPC 타입 계약

Electron main(TypeScript)과 Go sidecar 사이의 메시지 타입은 protobuf 또는 JSON schema 중 구현 시점에 확정한다. 어느 방식이든 코드 생성 파이프라인으로 양쪽 언어의 타입을 동기화한다. proto/ 또는 schema/ 디렉터리가 단일 진실 소스 역할을 한다.

## 플랫폼 타깃

MVP 타깃은 macOS arm64와 x64다. Go 정적 바이너리의 크로스컴파일 특성상 Windows와 Linux 지원은 MVP 이후 낮은 추가 비용으로 확장 가능하다.

## 빌드 / 테스트 / 배포 명령

구체적인 스크립트 이름과 옵션은 구현 시점에 확정된다. 아래는 명령 슬롯을 나타낸다.

| 목적 | 명령 슬롯 |
|------|-----------|
| 앱 개발 서버 실행 | `bun run dev` |
| 앱 전체 빌드 | `bun run build` |
| 단위 및 통합 테스트 | `bun run test` |
| Go sidecar 빌드 | `go build` (sidecar 디렉터리) |
| Go sidecar 테스트 | `go test ./...` (sidecar 디렉터리) |
| IPC 타입 코드 생성 | `bun run codegen` (확정 시 채움) |
| macOS 패키징 및 서명 | `electron-builder` (codesign + notarize 포함) |

빌드는 Go 도구 체인과 Bun이 모두 설치된 환경을 전제한다. Go sidecar 바이너리는 electron-builder의 extraResources 메커니즘으로 앱 번들에 포함된다.

## 관리 리스크 (스택 레벨)

아래 항목은 구현 전에 선제적으로 확인해야 하는 알려진 위험이다.

- xterm.js IME 이슈(#5734) — composingstart/end 오버레이 패치로 회피 계획. 한국어 입력 품질에 직접 영향.
- node-pty와 Electron 최신 버전 간 호환성 — 매 Electron 메이저 업그레이드마다 prebuilt binary 재빌드 필요.
- IPC 계약 드리프트 — TypeScript와 Go 타입이 어긋나지 않도록 코드 생성 파이프라인을 CI에서 강제.
- macOS codesign + notarization — Go 정적 바이너리 포함 전체 서명 파이프라인 검증 필수.
