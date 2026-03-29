<!-- tags: roadmap, phases, priorities, themes -->
# Roadmap

## 완료된 단계

- **Phase 1: 기반** — MVP, stream-json 통신 안정화, 코드 구조 정비 (M0+M1+M1.5)
- **Phase 2: UI/UX** — 시각 개선, 인터랙션 기초, 파일 변경 안전성, 일상 편의 (M2a+M2b+M3+M4)
- **Phase 3: 고도화** — 퍼미션 enforcement, 체크포인트 고도화, UX 개선, 구조 변경 (M5+M6a+M6b)
- **Phase 4: 레이아웃** — react-resizable-panels 기반 리사이저블 3패널 + 아이콘 스트립

## 현재 계획

### Phase 5: 기반 정비
- 기본 테마 (Terracotta) 적용 — CSS 변수 기반 6개 테마 시스템 설계 포함
- 렌더링 성능 최적화 — Sidebar memo, useMemo(sorted), streamBuffer 디바운스, toolCall 인덱싱(Map), React.memo 전면 적용
- 도구 블록 밀도 모드 — Compact/Normal/Verbose 3단계. 기본 Compact (완료 블록 아이콘+한줄 축약)

### Phase 6: 패널 고도화
- 우측 패널 자동 전환 + pin — 이벤트 기반 탭 전환, 사용자 클릭 시 고정
- Nexus 상태 표시 개선 — consult/decisions/tasks 표시 고도화
- 비용 추적 대시보드 — lastTurnStats 기반 누적 통계, 세션/일별 비용

### Phase 7: 테마 확장
- 나머지 5개 테마 구현 — GitHub Dark, Amethyst, Rosé Pine, Nord, Midnight Green
- 테마 선택 UI — 설정 화면에서 테마 전환

### Phase 8: 확장 기능
- 파일 브라우저 — 프로젝트 파일 트리 탐색
- 간단 에디터 — 기본 코드 편집
- 브라우저 내장 — Electron webview 기반 크로미움

### Phase 9: Agent Flow Chart
- reactflow 기반 에이전트 도구 호출 시퀀스 시각화

## 후속 과제
- Phase 4: 사이드바 접기/펼치기 시 버벅임 최적화 (Phase 5 성능 최적화에서 해결 예정)
- Phase 3: 체크포인트 되돌리기 CLI 컨텍스트 잔존 문제

## 미확정 후보
- Replay (세션 로그 기반 사후 재생)
- 프롬프트 템플릿 (재사용 가능한 프롬프트 저장/관리)
- 원격 에이전트 (경량 데몬 + WebSocket)

## 테마 목록
| 이름 | 컨셉 | 상태 |
|------|------|------|
| Terracotta | 따뜻한 다크 + 오렌지 강조 (기본) | Phase 5 |
| GitHub Dark | 무채색 + 파란 강조 (GitHub 계열) | Phase 7 |
| Amethyst | 보라 틴트 + 퍼플 강조 | Phase 7 |
| Rosé Pine | 핑크/로즈 + 라벤더 | Phase 7 |
| Nord | 북유럽 블루그레이 + 시안 | Phase 7 |
| Midnight Green | 네이비 + 녹색 (GitHub Dark 계열) | Phase 7 |