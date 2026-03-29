<!-- tags: workflow, commands, build, testing, branches -->
# Development Workflow

## 명령어

```bash
bun install          # 의존성 설치
bun run dev          # 개발 서버 (HMR, electron-vite dev)
bun run build        # 프로덕션 빌드 (electron-vite build)
bun run typecheck    # 타입 체크 (tsconfig.node.json + tsconfig.web.json)
bun run test:e2e     # Playwright E2E 테스트 (빌드 선행 필요)
```

## 개발 흐름

1. `bun run dev`로 개발 서버 시작 (HMR 지원)
2. Main Process 변경 시 자동 재시작
3. Renderer 변경 시 HMR으로 즉시 반영

## 브랜치 전략

- `main`: 통합 브랜치
- `feature/initial-setup`: 리모트 기본 브랜치
- 작업 브랜치: `feat/{phase-or-scope}` → main으로 머지

## 테스트

- **E2E**: Playwright (`e2e/` 디렉토리)
- **제약**: Playwright는 Electron 앱 스크린샷 불가 (`window.electronAPI` undefined)
- **QA**: 수동 UI 검증 필수 (스크린샷 촬영 포함)

## 빌드 구조

electron-vite가 3분할 빌드:
- `out/main/` — Main Process 번들
- `out/preload/` — Preload 스크립트
- `out/renderer/` — Renderer (React) 번들