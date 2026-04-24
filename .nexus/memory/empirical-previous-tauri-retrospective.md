# 이전 Tauri 프로젝트 폐기 회고

> 관찰 시점: 2026-04-14. 이 문서는 이전 시도(Tauri 2.x + Bun sidecar 기반 nexus-code)의 폐기 원인, 실측 함정, 그리고 현재 결정과의 매핑을 기록한다.

---

## 1. 폐기 원인

### Anthropic OAuth 정책 변경 (2026-02)

2026년 2월 Anthropic 정책 변경으로 `@anthropic-ai/claude-agent-sdk` 에서 Pro/Max 구독 OAuth 토큰을 사용한 CLI 호출 경로가 차단됐다. 외부 래퍼는 API 키 기반 호출만 허용된다. 이 프로젝트의 핵심 가치 제안인 "Pro/Max 구독으로 사용하는 에이전트 워크벤치"가 정책 한 번에 무효화됐다. 외부 CLI 래퍼 구조는 벤더 정책 변경 한 건에 전체 가치 제안이 붕괴할 수 있다는 구조적 취약성을 실증했다.

### `stream-json` 다중 턴 비공식 경로의 구조적 불안정

`--input-format stream-json`으로 두 번째 메시지를 처리할 때 발생하는 hang, session 미저장 이슈가 Anthropic 공식 레포에 4회 이상 독립 보고됐다(#3187, #25629, #39700, #41230). 보고 건 모두 미해결 또는 자동 종료 처리됐다. 공식 문서화되지 않은 경로 위에 쌓은 구현은 근본적으로 불안정하다. 이 프로젝트의 최후 미해결 버그(turn_end 후 두 번째 응답 UI 미표시)도 동일 경로 위에 위치해 있었다.

---

## 2. 실측 함정

### Tauri 2.10.1 proc macro 패닉

`tauri = "2"` 플로팅 지정이 Tauri 2.10.1까지 올라가면서 `tauri::generate_handler![]` proc macro가 패닉을 일으켰다. Rust 1.93.1 환경에서 재현됐다. OpenCode(`sst/opencode`)의 운영 버전인 2.9.5로 핀 고정하자 패닉이 해소됐다(commit `a26036f`). 플로팅 버전 지정 + proc macro 조합은 런타임이 아닌 컴파일 타임에 무작위 실패를 유발하므로, 의존 crate는 항상 버전을 고정해야 한다.

### `pino-pretty` transport의 `bun --compile` 번들 불가

`pino-pretty`는 내부적으로 `worker_threads` 동적 로딩을 사용한다. `bun --compile`로 단일 바이너리를 생성할 때 Bun 번들러가 이 동적 로딩 경로를 추적하지 못해 sidecar 실행 시 crash가 발생했다(commit `79f3436`의 Cycle B에서 해소 작업 수행). `bun --compile` 환경에서는 transport 계층의 동적 로딩 여부를 미리 확인해야 한다. 런타임에서 정상 동작하는 라이브러리가 단일 바이너리에서 동작한다고 가정하면 안 된다.

### SSE 30분+ 장시간 안정성 미검증

macOS WKWebView 내 `EventSource` 직접 구독은 POC 단계에서 정상 동작이 확인됐다(긍정 결과). 그러나 30분 이상 장시간 연결 안정성은 검증하지 못한 채 Cycle D로 이관됐고, 프로젝트가 폐기되어 결과 없이 종료됐다. turn_end 15초 후 `sse_disconnect`가 발생하고 재연결이 트리거되지 않는 현상도 해결하지 못했다(`.nexus/memory/workspace-ui-fix-backlog.md` 참조). 장시간 실행 안정성은 POC가 아닌 실측 사이클에서 선행 검증해야 한다.

---

## 3. 얻은 교훈 — 현재 결정 매핑

### per-turn spawn + `--resume <sessionId>` 만 사용 (Issue 5)

비공식 `stream-json` 다중 턴 경로는 사용하지 않는다. 표준 경로는 매 턴 프로세스를 spawn하고 `--resume <sessionId>`로 세션을 연결하며 `stdin.end()`로 종료하는 것이다. 이 결정은 현재 Issue 5의 HarnessAdapter 설계에 반영됐다. 비공식 경로 위의 구현은 벤더가 언제든 변경할 수 있으며, 이미 4건의 미해결 버그로 불안정성이 실증됐다.

### HarnessAdapter를 플러그인 경계로 격리 (Issue 5)

Anthropic / OpenAI 정책 변경에 제품 핵심 기능이 직접 노출되지 않도록 HarnessAdapter를 명확한 플러그인 경계로 분리한다. 이전 프로젝트는 CLI 호출 방식이 제품 정체성과 직결돼 있었고, 정책 변경 한 번에 전체 가치 제안이 무너졌다. 이 구조 분리는 현재 Issue 5 결정의 핵심 근거다.

### Runtime 장기 실행 메모리를 실측으로 확인 (Issue 8)

Runtime 선택 시 장기 실행 환경에서의 메모리 동작을 가정이 아닌 실측으로 검증한다. 이전 시도에서 `Bun.spawn` 기반 RSS 누수가 발견됐고, 이것이 현재 Issue 8에서 Go를 서버 런타임으로 선택한 근거 중 하나다. "개발 환경에서 동작한다"와 "장기 실행 프로덕션에서 안정적이다"는 다른 명제다.

### CJK 체크리스트를 릴리스 블로커로 공식화 (Issue 6)

이전 프로젝트의 폐기 시점까지 CJK 입력 환경에 대한 체계적인 검증이 없었다. 현재 Issue 6은 CJK 입력 호환성 체크리스트를 릴리스 블로커 항목으로 공식화했다. 대상 사용자 환경이 CJK라면 초기 사이클부터 검증 게이트에 포함해야 한다.

---

## 4. E2 사이클(2026-04) 역참조

이 회고의 교훈은 E2 문서화 사이클(Task 14)에서 아래 문서로 직접 연결됐다.

- `.nexus/context/terminal-shell-env.md` — 셸 환경 캡처/fallback 규칙과 direnv 사용자 hook 원칙 명문화
- `.nexus/memory/external-xterm-js.md` — xterm 정확 pin 정책 + 분기별 이슈 점검 루틴 고정
- `.nexus/memory/pattern-xterm-fork-escape-hatch.md` — 업스트림 블로커 발생 시 포크 전환 런북
- `.nexus/context/roadmap.md` / `.nexus/context/stack.md` — E2 MVP 컷·수동 게이트·폰트/OFL·네이티브 검증 명시

즉, "가정 대신 운영 규약으로 고정한다"는 교훈을 E2에서 문서 레벨로 실체화했다.

---

> 출처: `git log` commits `028afeb`, `35bcca1`, `a26036f`, `79f3436`, `f81b2f0` 및 `.nexus/memory/workspace-ui-fix-backlog.md`
