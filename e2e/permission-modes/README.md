# 권한 모드 E2E 시나리오 — 수동 검증 체크리스트

> **상태**: TODO — mock 인프라 구축 후 Playwright 자동화 활성화
>
> **이유**: 프로젝트에 Playwright 설정(`playwright.config.ts`, `test:e2e` 스크립트)과
> SSE 이벤트 mock 인프라가 아직 없음. 세 spec 파일은 `.skip`으로 작성되어
> mock 인프라가 갖춰지면 활성화할 수 있도록 구조만 잡아 두었음.

---

## 사전 조건

1. `bun run build` — shared → server/web → electron 순서로 전체 빌드
2. `bun run dev:server` 로 서버 실행 (기본 포트 3000)
3. Electron 앱 실행 또는 `bun run dev:web`으로 웹 앱 실행

---

## 시나리오 1 — 권한 모드 전환 즉시 반영

**목표**: status-bar 드롭다운에서 모드 변경 시 settings 탭에 즉시 반영되는지 확인

### 수동 검증 단계

- [ ] 앱 실행 후 워크스페이스를 하나 선택한다
- [ ] 화면 하단 status-bar 오른쪽에서 현재 권한 모드 드롭다운을 클릭한다
- [ ] "편집 허용" 항목을 선택한다
- [ ] status-bar에 "편집 허용" 텍스트와 FileCheck2 아이콘이 표시되는지 확인한다
- [ ] 설정 아이콘(톱니바퀴)을 클릭해 설정 모달을 연다
- [ ] "넥서스" 탭으로 이동한다
- [ ] "권한 모드" 항목에서 "편집 허용" 라디오 버튼이 선택(파란 테두리)되어 있는지 확인한다

### 합격 기준

- status-bar 드롭다운 변경 후 1초 이내 settings 탭에 반영
- settings 탭에서 해당 모드의 라디오 label이 `bg-[var(--accent-muted)] border-[var(--accent)]` 스타일로 강조됨

### mock 인프라 구축 시 자동화 포인트

```
1. GET /api/settings 응답 mock (permissionMode: 'default')
2. status-bar의 DropdownMenuTrigger(권한 모드) 클릭
3. DropdownMenuItem("편집 허용") 클릭
4. PUT /api/settings 요청 캡처 → body.permissionMode === 'acceptEdits' 검증
5. 설정 모달 열기 → 넥서스 탭
6. label[data-mode="acceptEdits"] 의 checked 상태 검증
```

---

## 시나리오 2 — plan 모드 차단 카드

**목표**: plan 모드에서 Edit 도구 호출 시 permission-deny-block 카드가 표시되고,
CTA 클릭으로 모드가 전환되는지 확인

### 수동 검증 단계

- [ ] 앱 실행 후 워크스페이스 선택
- [ ] status-bar 드롭다운 → "계획" 선택
- [ ] 채팅 입력창에 "README.md 고쳐줘" 입력 후 전송
- [ ] (실제 Claude 응답이 Edit 도구를 호출하면 서버가 deny 반환)
- [ ] 채팅 스트림에 빨간 테두리의 차단 카드가 나타나는지 확인
  - 헤더: `⊘ 차단됨 — Edit 도구`
  - "편집 허용으로 전환" 버튼 표시 여부
  - "무시하고 계속" 버튼 표시 여부
- [ ] "편집 허용으로 전환" 버튼 클릭
- [ ] status-bar가 "편집 허용"으로 변경되는지 확인

### 합격 기준

- permission-deny-block 카드의 배경: `rgba(248,81,73,0.05)`, 테두리: `rgba(248,81,73,0.30)`
- "편집 허용으로 전환" 클릭 후 status-bar 아이콘이 FileCheck2로 바뀜
- PUT /api/settings 요청에 `permissionMode: 'acceptEdits'` 포함

### mock 인프라 구축 시 자동화 포인트

```
1. SSE 스트림 mock — permission_denied 이벤트 발행:
   { type: 'permission_denied', toolName: 'Edit', reason: 'plan 모드에서 편집 차단', source: 'mode' }
2. permission-deny-block 카드 DOM 존재 확인
3. "편집 허용으로 전환" 버튼 클릭
4. status-bar 텍스트가 "편집 허용"인지 확인
```

---

## 시나리오 3 — protected path 배지 + scope 숨김

**목표**: `.env` 같은 보호 경로에 대한 Write 요청 시 permission-block에
`🔒 보호 경로` 배지와 빨간 좌측 2px 라인이 표시되고,
scope split 버튼 없이 단일 "승인 (1회)" 버튼만 노출되는지 확인

### 수동 검증 단계

- [ ] 앱 실행 후 워크스페이스 선택
- [ ] status-bar 드롭다운 → "기본" 선택
- [ ] 채팅 입력창에 ".env 파일 만들어줘" 입력 후 전송
- [ ] (실제 Claude 응답이 Write 도구를 `.env` 경로로 호출)
- [ ] 채팅 스트림에 권한 요청 카드(permission-block)가 나타나는지 확인
  - 우측 상단에 `🔒 보호 경로` 배지가 표시되는지
  - 카드 좌측에 빨간(#ef4444) 2px 세로 라인이 있는지
  - 카드 배경이 `rgba(239,68,68,0.08)`인지
- [ ] 버튼 영역에 "승인 (1회)" 단일 버튼만 있고 ▾(scope 드롭다운) 버튼이 없는지 확인
- [ ] 하단에 "보호 경로는 매번 확인합니다" 텍스트가 있는지 확인

### 합격 기준

- 배지 텍스트: `🔒 보호 경로`
- 배지 스타일: `background: rgba(239,68,68,0.15)`, `color: #f87171`
- 좌측 border: `borderLeft: '2px solid #ef4444'`
- scope split DropdownMenu 요소 미노출
- "승인 (1회)" 단일 버튼 노출

### mock 인프라 구축 시 자동화 포인트

```
1. SSE 스트림 mock — permission_request 이벤트:
   { type: 'permission_request', id: 'test-1', toolName: 'Write',
     toolInput: { file_path: '.env', content: '' },
     protectedHint: ['.env'], source: 'protected' }
2. .permission-block 카드 존재 확인
3. "🔒 보호 경로" 배지 텍스트 확인
4. borderLeft 스타일 값 검증
5. DropdownMenuTrigger(▾) 미존재 확인
6. "승인 (1회)" 버튼 존재 확인
```

---

## mock 인프라 구축 가이드

E2E 자동화를 활성화하려면 다음이 필요합니다:

### 1. Playwright 설치

```bash
bun add -D @playwright/test
bunx playwright install chromium
```

### 2. playwright.config.ts 작성

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'bun run dev:web',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
})
```

### 3. SSE mock 서버 또는 msw(Mock Service Worker) 설정

- `/api/settings` GET/PUT 인터셉트
- `/api/events/:sessionId` SSE 스트림을 controllable mock으로 교체
- `permission_request`, `permission_denied`, `permission_settled` 이벤트 발행 API

### 4. root package.json에 스크립트 추가

```json
"test:e2e": "bun run build && playwright test"
```

