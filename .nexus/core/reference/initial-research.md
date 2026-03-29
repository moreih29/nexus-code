<!-- tags: research, reference, patterns, ux, initial -->
# Initial Research Summary

프로젝트 초기(M0~M2) 5개 도메인 조사 결과 요약.

## 조사 범위

| 도메인 | 대상 앱 | 패턴 수 |
|--------|---------|---------|
| 대화 UX | ChatGPT, Claude.ai, Gemini | 7 |
| 도구 호출 시각화 | VS Code Copilot, Zed, JetBrains AI | 7 |
| 터미널 출력 | Warp Terminal | 5 |
| 파일 편집 | Cursor (inline, Chat Apply, Agent) | 4 |
| 에이전트 오케스트레이션 | Devin, OpenHands, SWE-agent | 7 |

총 31개 패턴 → 핵심 채택 18개, 변형 적용 9개, 참고 4개.

## 핵심 발견

### 대화 UX
- 스트리밍 출력, 턴 구분, 상태 피드백(Stop/에러 CTA), 코드 블록 구문 강조가 필수
- 마크다운 렌더링 최적화 필요 (스트리밍 중 파서 반복 호출 방지)

### 도구 호출
- 기본 접힘(VS Code)과 실시간 스트리밍(Zed)의 trade-off
- 체크포인트(git stash)가 무거운 diff 리뷰보다 낮은 마찰로 안전망 제공
- 계층적 승인 범위 (once/session/workspace/permanent)

### 터미널 (Warp)
- 블록 기반 출력 — 명령+결과를 원자 단위로 묶는 패러다임
- exit code 시각화, 경과 시간 표시, Sticky Command Header
- AI가 부속품이 아닌 1급 시민

### 파일 편집 (Cursor)
- 에디터 없는 채팅 래퍼에서는 인라인 편집/Tab 완성 근본 불가
- Chat Apply(PermissionCard diff) + 멀티파일 Keep/Undo가 대안

### 에이전트 오케스트레이션
- 7가지 UX 패턴: 3패널 캔버스, Co-Planning, Action Guards, 스트리밍 진행상태, Co-Tasking, 역할 기반 시각화, 상태 기계
- 공통 원칙: 제어 가능성, 투명성, 점진적 공개, 리스크 기반 위임

## 교차 패턴 → 설계 원칙

31개 패턴에서 도출된 4대 교차 패턴이 design-principles.md로 정립됨:
1. Progressive Disclosure
2. 승인/제어권 스펙트럼
3. 상태 기계 모델
4. 사전 승인/사후 복구 하이브리드