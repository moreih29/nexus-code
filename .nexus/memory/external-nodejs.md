# external-nodejs

스냅샷 날짜: 2026-04

## 현재 상태 요약

- **Active LTS**: Node.js 24 (2025-10 승격, 2028-04 EOL) — 현재 권장 버전
- **Maintenance**: Node.js 22
- **EOL 임박**: Node.js 20 (2026-04-30 EOL)
- **거버넌스**: OpenJS Foundation. 장기 유지보수 보장, 기업 채택 광범위.
- **Electron 35 내장**: Node.js 22.15.0 — Electron main 프로세스는 이 버전을 사용. sidecar는 별도 Node.js 24 바이너리 가능하나 ABI 호환 주의 필요.

## 우리 아키텍처에서의 역할

**탈락.** sidecar 런타임 후보였으나 채택하지 않음. Go 대비 메모리 불리(idle RSS ~55MB vs Go ~10-20MB)하고, node-pty를 Electron 메이저 업그레이드마다 rebuild해야 하는 ABI dance 부담이 있음. Go sidecar로 대체. 단, Electron main 프로세스의 Node.js(v22.15.0)는 우리 스택에서 계속 사용됨 — 탈락은 sidecar 런타임 한정.

## TypeScript 네이티브 실행

Node.js 24.3+부터 type stripping stable (experimental 딱지 제거). 단, decorator, const enum, tsconfig paths는 미지원. 복잡한 코드베이스에는 tsx 또는 esbuild AOT 병행 필요.

## SEA (Single Executable Apps)

Node.js 25.5에서 `--build-sea` 단일 커맨드 UX 도입. 그러나 Node.js 24 LTS에서는 여전히 postject 방식. **결정적 한계: native addon(node-pty 등) 포함 불가.** sidecar 단일 바이너리 배포 경로로 실용적이지 않음. Node.js 26 LTS 이후 재평가 대상.

## 알려진 구체 이슈

| 항목 | 내용 |
|---|---|
| Startup 회귀 | Node 20→22 전환 시 ~40% 증가 (19.6ms→27.5ms). Node 24 V8 13.6으로 일부 회복. Node 24 기준 ~30.5ms. |
| node-pty Electron 33 rebuild 실패 | #728 (2024-11, C++ 플래그 문제). Electron 35 prebuilt 명시적 확인 없음. |
| chokidar 5 ESM-only 전환 | 2025-11. Node 20.19+ 필수. CJS 환경 마찰 발생. |

## Electron 통합 패턴

Utility Process API(Electron 22+)가 child_process.fork 대비 공식 권장. MessagePort + Chromium Services 기반으로 renderer 직접 통신 가능, crash isolation 향상. VSCode extension host 패턴이 사실상 업계 표준.

## HTTP 처리량

Fastify 기준 87K req/s. sidecar용도(IPC 중계, LSP pass-through)에는 충분한 수치.

## 라이선스

MIT

## 출처

- https://nodejs.org/en/about/releases
- https://nodejs.org/api/single-executable-applications.html
- https://releases.electronjs.org
- https://github.com/microsoft/node-pty/issues/728
