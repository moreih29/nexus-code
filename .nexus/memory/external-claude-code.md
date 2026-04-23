# external-claude-code

스냅샷 날짜: 2026-04

---

## 개요

Anthropic이 공식 배포하는 터미널 AI 코딩 하네스. CLI 무료, 소스 비공개.

---

## 배포 방식

- **배포 경로**: npm 레지스트리 및 Anthropic 공식 배포 채널을 통해 CLI 바이너리로 설치.
- **플랫폼**: macOS / Linux / Windows.
- **내부 런타임**: 내부 구현 상세라 여기서는 다루지 않음 (관찰·통합 인터페이스만 기록).

---

## 세션 저장 경로 및 포맷

- **경로**: `~/.claude/projects/<프로젝트 해시>/<sessionId>.jsonl`
- **포맷**: JSONL (JSON Lines). 턴마다 한 줄 추가 (append-only).
- **특성**: 파일이 append-only이므로 `tail -f` 또는 fsnotify로 실시간 관찰 가능.

---

## 관찰 가능한 이벤트

**Hooks API** (공식, 안정):

| 훅 이름 | 발화 시점 |
|---|---|
| `PreToolUse` | 도구 실행 직전 |
| `PostToolUse` | 도구 실행 완료 후 |
| `Notification` | 에이전트 알림 발생 시 |
| `Stop` | 턴 종료 시 |

**세션 파일 tail**:
- `~/.claude/projects/<proj>/<session>.jsonl`을 fsnotify로 구독해 신규 이벤트 수신 가능.
- 훅 API와 세션 파일 tail은 병행 사용 가능.

**stdout**: 구조화 이벤트 출력 지원 (`--output-format json` 옵션). 단, 비공식 stream-json 다중 턴 경로는 스키마 안정성이 낮으므로 nexus-code에서 사용 금지.

---

## per-turn spawn + `--resume` 지원

- **per-turn spawn**: 공식 지원. 매 턴마다 새 프로세스를 스폰하는 패턴으로 사용 가능.
- **`--resume <sessionId>`**: 공식 안정 경로. 지정한 세션 파일 경로를 기준으로 이전 대화 컨텍스트를 이어붙임.
- nexus-code 채택 패턴: per-turn spawn + `--resume` 조합만 사용. 비공식 다중 턴 스트림 금지.

---

## 알려진 IME / 터미널 / CJK 관련 이슈

아래 이슈는 2026-04 현재 모두 미해결 상태.

| 이슈 번호 | 내용 |
|---|---|
| #22732 | IME 조합 문자 소실 — 조합 중 문자가 소실되는 현상 |
| #22853 | IME 조합 문자 소실 (다른 재현 경로) |
| #16372 | 커서 위치 불일치 — CJK 입력 시 커서가 잘못된 위치에 표시 |
| #11885 | 마크다운 raw 표시 — 렌더링 없이 원문 그대로 출력 |
| #13600 | 마크다운 raw 표시 (추가 재현 케이스) |


---

## 스키마 안정도

- **Hooks API 이벤트 스키마**: 공식 지원, 상대적으로 안정적. Anthropic이 하위 호환을 의식하며 관리.
- **세션 파일 JSONL 스키마**: 내부 포맷으로 공식 보장 없음. 버전업 시 필드 추가·변경 가능성 있음.
- **변동 빈도 평가**: 세 하네스 중 중간. Codex보다 안정적, opencode SQLite 수준에 근접.
- **어댑터 보수 부담**: 중간. Hooks API를 주 관찰 경로로 쓰면 안정적이나, JSONL 포맷 변경 시 파서 보수 필요.

---

## 라이선스

비공개 소스 (Closed Source). CLI 자체는 무료 사용 가능.

---

## 출처

- <https://github.com/anthropics/claude-code>
