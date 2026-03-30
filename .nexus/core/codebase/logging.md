<!-- tags: logging, logger, categories, session-split, electron-log -->
# Logging System

## 구조

electron-log v5.4.3 기반 구조화 로깅. 11개 카테고리 서브로거 + 세션별 파일 분리.

## 카테고리

| 카테고리 | 대상 | 라우팅 |
|----------|------|--------|
| `app` | 앱 생명주기 (ready, window, closed) | main.log |
| `settings` | 설정 변경 | main.log |
| `plugin` | 플러그인 로드/이벤트 | main.log |
| `cli` | CLI 프로세스 (spawn, crash, restart) | session-{id}.log |
| `stream` | 스트림 파싱 (메시지 타입, 에러) | session-{id}.log |
| `hook` | HookServer (요청, 승인, 차단) | session-{id}.log |
| `permission` | 권한 규칙 저장/삭제 | session-{id}.log |
| `agent` | 에이전트 트래킹 (시작/종료/도구) | session-{id}.log |
| `checkpoint` | 체크포인트 생성/복원 | session-{id}.log |
| `ipc` | IPC 통신 | 하이브리드 (sessionId 유무) |
| `session` | 세션 관리 | 하이브리드 (sessionId 유무) |

## 사용법

```typescript
// Main process
import { logger } from '../logger'
logger.cli.info('spawned', { pid: 123, sessionId: 'abc' })  // → session-abc.log
logger.app.info('app ready', { version: '1.0' })             // → main.log

// Renderer process
import log from 'electron-log/renderer'
const rlog = log.scope('renderer:chat-panel')
rlog.info('message sent')  // → main.log (콘솔 + 파일)
```

## 라우팅 메커니즘

1. `createCategoryLogger(cat)` → `logAndRoute()` 내부 함수
2. `scope[level](entryStr)` → electron-log 콘솔 출력 + main.log (hooks 필터링)
3. `log.hooks` → `transportName === 'file'` 일 때 세션 메시지 `return false` (main.log 제외)
4. `getOrCreateSessionStream(sessionId).write()` → 세션 파일에 직접 쓰기

## 파일 관리

- **main.log**: 10MB 로테이션, 타임스탬프 아카이브
- **세션 파일**: 세션 종료 시 `closeSessionStream()` + `endRawSession()` 으로 스트림 닫기
- **정리**: 앱 시작 시 `cleanupOldSessionLogs()` — 30일 초과 또는 100개 초과 삭제

## JSON 구조화 포맷

```json
{"_structured":true,"ts":"2026-03-30T12:00:00.000Z","level":"info","cat":"cli","msg":"spawned","pid":123,"sessionId":"abc"}
```

## 환경별 레벨

- dev: 파일=debug, 콘솔=debug
- prod: 파일=debug, 콘솔=warn
- `NEXUS_LOG_LEVEL=verbose` 환경변수로 오버라이드
