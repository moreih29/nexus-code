<!-- tags: design, principles, progressive-disclosure, state-machine, permissions -->
# Design Principles

리서치에서 도출된 4대 교차 패턴. 모든 UI 컴포넌트 설계의 기준.

## 1. Progressive Disclosure (점진적 공개)

모든 정보 표시 컴포넌트는 4단계 계층으로 표현한다.

| 레벨 | 정보량 | 트리거 |
|------|--------|--------|
| Level 0 | 상태 인디케이터 (아이콘, 색상 도트) | 항상 표시 |
| Level 1 | 한 줄 요약 | 기본값 |
| Level 2 | 핵심 내용 확장 (입출력, diff) | 클릭 전환 |
| Level 3 | 전체 디버그 정보 (LLM 로그, 토큰, 비용) | 별도 패널 |

**기본 표시는 Level 1.** 완료+성공은 Level 1 접힘, 실행 중/에러는 Level 2 유지.

### 적용 대상
- **ToolCard**: Level 0(상태 배지) → Level 1(헤더+요약) → Level 2(입출력) → Level 3(RightPanel raw JSON)
- **MessageBubble**: Level 0(역할 아이콘) → Level 1(본문) → Level 2(메타데이터, 호버 표시) → Level 3(raw JSON)
- **AgentCard**: Level 0(상태 도트) → Level 1(에이전트명+상태) → Level 2(실행 중 ToolRow) → Level 3(전체 타임라인)

## 2. 승인/제어권 스펙트럼

리스크 3단계 × 범위 4단계로 세분화.

**리스크**: 저위험(읽기 전용, 자동) → 중위험(파일 쓰기, 사전 승인) → 고위험(비가역적, 항상 승인+추론 경로)

**범위**: 이번 한 번 → 세션 → 워크스페이스 → 영구

**도구별 분류**: Read/Glob/Grep=저, Write/Edit/Bash(일반)=중, Bash(rm/force push)=고

## 3. 상태 기계 모델

Session → Agent → Tool 3계층 연동.

```
Session: idle → running → waiting_permission → running → ended | error
Agent:   idle → running → paused → completed | error
Tool:    pending → running → done | error
```

**색상 코드** (전체 컴포넌트 통일):
- running: `text-blue-400`, `bg-blue-400 animate-pulse`
- done: `text-green-400`, `bg-green-500`
- error: `text-red-400`, `bg-red-400`
- waiting: `text-yellow-400`, `bg-yellow-400`
- idle: `text-gray-500`, `bg-gray-500`

## 4. 사전 승인/사후 복구 하이브리드

| 리스크 | 전략 | 마찰 |
|--------|------|------|
| 저위험 | 자동 실행 (PermissionCard 미표시) | 없음 |
| 중위험 | 사전 승인 + 체크포인트 (git stash) | 중간 |
| 고위험 | 항상 승인 + 추론 경로 필수 표시 | 높음 |