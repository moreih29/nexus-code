# Dev Smoke Test Protocol

Nexus Code dev 환경 수동 검증 체크리스트. 커밋 후 런타임 경로 변경 검증 시 참조.

출처: `.nexus/memory/path-guard-relocation-lessons.md §4`

---

## 1. 사전 조건 — Port Listener 상태 확인

- [ ] `lsof -nP -iTCP:3000,5173 -sTCP:LISTEN` 실행 → 출력 없어야 함
- [ ] 출력 있으면: `kill -TERM <pid>` 직접 종료 후 orphan 확인
  ```bash
  ps -p <pid> -o ppid=   # 결과 = 1 이면 재부모화 잔존물 → 함께 제거
  ```
- [ ] `pwd` 로 cwd 확인 → repo root(`nexus-code/`) 여야 안전

**실패 신호**: port 점유 PID 의 ppid=1 → orphan. kill 후 `lsof` 재확인 필수.

---

## 2. 클린 빌드

- [ ] `bun run clean && bun install`
- [ ] `bun run build` — `scripts/dev.ts` 가 `shared → server/web → electron` 순서 강제

**실패 신호**: shared 빌드 실패 시 이후 패키지에 무작위 TS 오류 발생 → shared 먼저 확인.

---

## 3. Dev 서버 기동

- [ ] `bun run dev` — repo root에서 실행
- [ ] 다음 출력이 **모두** 나타날 때까지 대기
  - server: `Listening on http://localhost:3000`
  - web: Vite `ready in ...ms` (`:5173`)

**실패 신호**: `EADDRINUSE 3000` → 1단계 미완료. orphan port 점유 상태.

---

## 4. 수동 확인 항목 (5종)

- [ ] **워크스페이스 열기** — `GET /api/workspaces` 200, 카드 렌더링 확인
  - 실패 신호: 빈 목록 = DB 초기화 미완 또는 server 미기동
- [ ] **CC 세션 spawn** — `POST /api/workspaces/:id/sessions` 201, 스트림 이벤트 수신 확인
  - 실패 신호: 스트림 없음 = stream-parser 이벤트 타입 변경 후 파싱 실패
- [ ] **권한 요청 허용/거부** — hook POST 수신, pending 큐에서 제거 확인
  - 실패 신호: 버튼 무응답 = approval-bridge `respond()` 경로 또는 SSE push 누락
- [ ] **브라우저 리로드** — 세션 restore, 히스토리 재표시 확인
  - 실패 신호: 빈 히스토리 = history-parser JSONL 경로 변경 또는 DB 쿼리 오류
- [ ] **통합 로그 채널 점검** — `~/.nexus-code/logs/{ws-sanitized}/{date}.jsonl` + `_system/electron-main-{date}.log` 영속 확인 (`NEXUS_LOG_DEV=1` 시 `_system/dev-{date}.log` 추가)
  - 실패 신호: workspace-logger 경로 오탈자 (`.nexus-code` vs `.nexus`) 또는 sanitize 매핑 회귀. `workspace-id.test.ts` 재확인

---

## 5. 종료 후 Port 해제 확인

- [ ] dev 서버 `Ctrl+C` 후: `lsof -nP -iTCP:3000,5173 -sTCP:LISTEN` → 출력 없어야 함

**실패 신호**: 종료 후에도 출력 있음 → orphan(ppid=1). 직접 kill 필요. §6 참조.

---

## 6. Orphan 감지 및 대응

**실패 신호**: 종료 후 `lsof` 출력에 nexus 관련 PID 잔존 → ppid=1 확인 후 아래 절차 적용.

- [ ] orphan 판별: `ps -p <pid> -o ppid=` → 결과 = `1` 이면 재부모화 잔존물
- [ ] 부모의 자식 재귀 종료: `pkill -TERM -P <parent_pid>`
- [ ] process group leader 기준 일괄 종료: `kill -- -<PGID>`

`ppid=1` 인 nexus-code 관련 프로세스는 모두 정리 대상. `tsx --watch` 등 Node `--watch` 계열은 자식을 별도 PID로 spawn → 부모 kill만으로 자식 미종료. 실증 방법: port listener 기준(`lsof`)으로 확인. PID tree 탐색보다 빠르고 정확.
