<!-- tags: architecture, design, decisions, constraints -->
# Design

## 핵심 아키텍처

Electron 3계층 구조:
- **Main Process**: ControlPlane (RunManager, HookServer, PermissionHandler, SessionManager) + PluginHost + IPC Handlers
- **Preload**: contextBridge API 노출
- **Renderer**: React 19 + Zustand + Tailwind CSS v4

## CLI 통신

`claude -p --input-format stream-json --output-format stream-json` subprocess 양방향 NDJSON 통신 + HTTP Hook Server (관찰/차단 가능, exit code 2).

## 기술 선택 이유

| 결정 | 선택 | 근거 |
|------|------|------|
| 런타임 | Electron | Chromium 일관성, Tauri/Electrobun은 WebKit 문제 |
| CLI 통신 | stream-json | 구조화된 NDJSON, Agent SDK는 API키 필수 |
| 확장성 | PluginHost | MVP부터 플러그인 프로토콜 |
| 패키지 | Bun | 빠른 설치, 런타임은 Node.js |
| UI | shadcn/ui + Ark UI | 커스터마이즈 + Tailwind 기반 |

## 설계 원칙 (4대 교차 패턴)

1. **Progressive Disclosure** — 4단계 정보 계층
2. **승인/제어권 스펙트럼** — 리스크 3단계 × 범위 4단계
3. **상태 기계 모델** — Session→Agent→Tool 계층 연동
4. **사전 승인/사후 복구 하이브리드** — 리스크 기반 분기

## 아키텍처 제약 (5개)

1. stream-json stdin은 user message만 전송 가능
2. PreToolUse 훅 exit code 2로 도구 차단 가능
3. 에디터 없는 채팅 래퍼 (인라인 편집 불가)
4. AskUserQuestion -p 모드 즉시 is_error 반환
5. CLI 프로젝트 루트는 git 루트 의존