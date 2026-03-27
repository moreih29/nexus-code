<!-- tags: development, commands, build, test, e2e, workflow -->
<!-- tags: development, commands, build, test, e2e -->
# Development

## 명령어

| 명령 | 설명 |
|------|------|
| `bun install` | 의존성 설치 |
| `bun run dev` | 개발 서버 (electron-vite dev, HMR) |
| `bun run build` | 프로덕션 빌드 (electron-vite build → `out/`) |
| `bun run preview` | 빌드 결과 미리보기 |
| `bun run typecheck` | 타입 체크 (tsconfig.node.json + tsconfig.web.json) |
| `bun run test:e2e` | E2E 테스트 (Playwright, 빌드 선행 필요) |
| `bun run test:e2e:screenshot` | 스크린샷 테스트만 실행 |

## E2E 테스트

- Playwright로 Electron 앱 자동화
- 테스트 디렉토리: `e2e/`
- 빌드된 `out/main/index.js`를 직접 실행
- 스크린샷: `e2e/screenshots/` (gitignore됨)
- 설정: `playwright.config.ts` (30초 타임아웃, retry 0)

## 빌드 출력

- `out/`: electron-vite 빌드 결과 (gitignore됨)
- `dist/`, `dist-electron/`: 패키징 결과 (gitignore됨)
- `release/`: Electron 릴리스 (gitignore됨)

## electron-vite 구성

`electron.vite.config.ts`에서 3분할 빌드:
- **main**: `externalizeDepsPlugin()` (Node.js 모듈 external)
- **preload**: 동일
- **renderer**: React SWC + Tailwind CSS 플러그인, `@renderer`/`@shared` alias

## 런타임 의존성

- Claude Code CLI (`claude` 바이너리)가 시스템에 설치되어 있어야 함
- 탐색 순서: `/usr/local/bin/claude` → `/opt/homebrew/bin/claude` → npm global bin → PATH fallback

## 앱 데이터

- 워크스페이스 목록: `~/.nexus-code/workspaces.json`
- 세션 히스토리: `~/.claude/projects/` (Claude Code CLI 자체 디렉토리)
