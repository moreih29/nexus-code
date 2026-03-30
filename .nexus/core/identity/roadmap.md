<!-- tags: roadmap, phases, priorities, themes -->
# Roadmap

## 완료된 단계

- **Phase 1: 기반** — MVP, stream-json 통신 안정화, 코드 구조 정비 (M0+M1+M1.5)
- **Phase 2: UI/UX** — 시각 개선, 인터랙션 기초, 파일 변경 안전성, 일상 편의 (M2a+M2b+M3+M4)
- **Phase 3: 고도화** — 퍼미션 enforcement, 체크포인트 고도화, UX 개선, 구조 변경 (M5+M6a+M6b)
- **Phase 4: 레이아웃** — react-resizable-panels 기반 리사이저블 3패널 + 아이콘 스트립
- **Phase 5: 기반 정비** — Terracotta 테마 + 렌더링 성능 최적화 + 도구 블록 밀도 모드
- **Phase 6: 패널 고도화** — 우측 패널 자동 전환 + Nexus 타임라인 + 비용 추적
- **Phase 7: 테마 확장** — 6개 테마 (GitHub Dark, Amethyst, Rosé Pine, Nord, Midnight Green) + 테마 선택 UI + 툴 상태 버그 수정

## 현재 진행

### 워크스페이스 세션 전환 안정화 (fix/workspace-session-switching)
- sessionStore 싱글톤 → Store Factory 패턴 (createStore + Context) 리팩토링
- 워크스페이스별 독립 세션 스토어 — Always-Live 방식
- IPC 이벤트 sessionId 기반 라우팅 + getActiveStore() fallback
- RightPanelUIStore cleanup() 추가
- 스트리밍 복원 — --include-partial-messages 플래그 추가
- 이중 버퍼 스트리밍 UX — StreamingMessage 컴포넌트 (적응형 드레인 + MarkdownRenderer 직접 렌더 + 커서 애니메이션)

## 향후 계획

### Phase 8: 확장 기능
- 파일 브라우저 — 프로젝트 파일 트리 탐색
- 간단 에디터 — 기본 코드 편집
- 브라우저 내장 — Electron webview 기반 크로미움

### Phase 9: Agent Flow Chart
- reactflow 기반 에이전트 도구 호출 시퀀스 시각화

## 후속 과제
- Phase 3: 체크포인트 되돌리기 CLI 컨텍스트 잔존 문제

## 미확정 후보
- Replay (세션 로그 기반 사후 재생)
- 프롬프트 템플릿 (재사용 가능한 프롬프트 저장/관리)
- 원격 에이전트 (경량 데몬 + WebSocket)

## 테마 목록
| 이름 | 컨셉 | 상태 |
|------|------|------|
| Terracotta | 따뜻한 다크 + 오렌지 강조 (기본) | 완료 (Phase 5) |
| GitHub Dark | 무채색 + 파란 강조 (실제 GitHub 팔레트) | 완료 (Phase 7) |
| Amethyst | 보라 틴트 + 퍼플 강조 | 완료 (Phase 7) |
| Rosé Pine | 핑크/로즈 + 라벤더 | 완료 (Phase 7) |
| Nord | 북유럽 블루그레이 + 시안 | 완료 (Phase 7) |
| Midnight Green | 네이비 + 녹색 | 완료 (Phase 7) |