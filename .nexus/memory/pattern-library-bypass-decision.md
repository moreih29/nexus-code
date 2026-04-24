# Library bypass 의사결정 기준

## 언제 쓰는 패턴

외부 library가 반복된 hotfix에도 증상이 잔존할 때, library 자체를 교체하거나 그 layer를 bypass하는 결정을 내리는 지점.

react-resizable-panels 경험(empirical-retrospective는 `external-react-resizable-panels.md` 참조)에서 5회 hotfix 실패 후 library 제거로 해결. 비슷한 패턴 재발 방지 목적.

## 진입 조건 (ALL)

1. **같은 library 또는 동일 레이어에서 3회 이상 hotfix 실패**
2. 각 hotfix가 **서로 다른 가설**이었음 (같은 시도 반복 아님)
3. 증상이 **재현 가능**하며 자동 검증으로는 통과하는데 사용자 체감은 실패
4. **외부 자료 조사(researcher)**로 유사 사례 확인했으나 우리 환경과 완전 일치하는 해결책 없음
5. library 내부 상태 관찰 경로가 제한적 (debug hook · 노출된 attr 부족)

## Bypass 단계

### Step 1 — 격리 실험 (30분)
- library만 사용하는 minimal reproduction 생성
- 우리 코드 컨텍스트 배제 후 library만 단독 테스트
- 동작하면 우리 코드 문제, 동작 안 하면 library 자체 문제

### Step 2 — 대안 경로 탐색
| 우선순위 | 경로 | 판단 기준 |
|---|---|---|
| 1 | **library 버전 다운그레이드** | 최근 버전의 알려진 회귀가 있을 때 |
| 2 | **library 교체** | 대안이 유사 API·적절한 생태계 성숙도·bundle size 수용 가능할 때 |
| 3 | **custom 구현** | 핵심 기능이 제한적(drag 기반 resize는 <100줄)이고 우리 요구 범위가 좁을 때 |

### Step 3 — Engineer 전권 위임
- Lead 가설이 반복 실패했다면, 동일 Lead가 계속 hypothesize하면 같은 실수 반복 위험
- engineer persistent session에 context 전부 전달 + 광범위 허용(library 교체·custom 구현)
- Lead는 제약만 유지(정체성·UX·범위)

## 결정 가중치

| 요인 | Weight | 비고 |
|---|---|---|
| library 사용 범위 | 좁을수록 bypass ↑ | 한 컴포넌트만 쓰면 교체 쉬움 |
| 생태계 의존도 | 높을수록 bypass ↓ | Radix·Tanstack 등 깊이 박혀있으면 신중 |
| 대안 성숙도 | 높을수록 bypass ↑ | allotment 등 |
| 유지보수 비용 | custom이 간단하면 ↑ | resize 80줄 vs 복잡 UI 3000줄 |
| bundle size 영향 | 감소면 ↑ | 우리 경우 -53KB |
| a11y·touch·keyboard 요구사항 | 높을수록 custom ↓ | library가 커버하는 영역 재구현 부담 |

## 이번 사례 적용 결과

- react-resizable-panels 적용 범위: App.tsx의 workspace/shared 패널 resize만(좁음)
- 생태계 의존도: shadcn wrapper만 사용(얕음)
- 대안 검토: allotment / react-split / react-split-pane / custom 모두 후보
- 선택: **custom** — drag 기반 resize는 pointer handler 80줄, library 제거로 bundle 감소, React 19 + Tailwind v4 조합 충돌 영역 자체 소거
- 결과: 1회 수정으로 해결(24ebee1), 5회 hotfix 루프 종료

## 후행 조치

- `.nexus/memory/external-<library>.md`에 실패 기록 작성 (증거·증상·시도 이력)
- 해당 library 제거 시 dead code·dependency 정리
- 비슷한 library 도입 검토 시 본 pattern 먼저 참조

## 주의

bypass는 **library 생태계 전체를 가볍게 여기자는 패턴이 아님**. 반복 실패 후 **손절** 결정을 구조화한 것. 대부분의 경우 library를 잘 쓰는 것이 더 현명하다.
