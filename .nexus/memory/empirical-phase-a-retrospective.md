# Runnable Shell 회고

Runnable Shell 게이트에서 발견한 결함과 반복 가능한 교훈이다.

## 핵심 교훈

### xterm 애드온은 proposed API·CSS·포커스를 함께 검증한다

xterm.js 애드온 사용 시 proposed API 플래그, `@xterm/xterm/css/xterm.css` 임포트, 활성 탭 포커스 이동이 모두 필요했다. 렌더링만 확인하는 자동 테스트는 입력 가능성까지 보장하지 않는다.

### 개발·프로덕션 renderer 경로를 모두 smoke한다

Electron dev renderer fallback은 개발 서버 URL과 preview 빌드 경로가 달라질 때 깨질 수 있다. native smoke는 개발·프로덕션 경로 분기를 모두 실행해야 한다.

### 워크스페이스 경로 주입은 통합 계층에서 검증한다

터미널 cwd는 workspace id가 실제 absolute path로 해석되는 경로까지 포함해 검증해야 한다. 단위 테스트가 router 내부 로직을 통과해도 실제 워크스페이스 열기·닫기·전환 경로에서 cwd 불일치가 남을 수 있다.

### WebGL 터미널은 가시성 전환 수동 게이트가 필요하다

빠른 워크스페이스 전환 중 WebGL texture atlas와 DOM 타이밍이 어긋나면 자동 테스트로 재현하기 어려운 시각적 손상이 생길 수 있다. 빠른 전환 시 시각적 안정성은 수동 릴리스 게이트로 유지한다.

### 종료 시 프로세스 누락은 운영 가정으로 검증한다

앱 종료 후 sidecar와 node-pty 프로세스가 남지 않는지 확인해야 한다. 이 검증은 Electron main 종료 경로가 외부 프로세스를 정리한다는 운영 가정을 뒷받침한다.

## 이관 역참조

- `CHANGELOG.md` — PASS 판정·범위·이관 결정 요약
- `.nexus/memory/pattern-phase-gate-checklist.md` — 재사용 가능한 체크리스트 구조
