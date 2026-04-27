# M3 인수인계 사이클 회고

우리가 마주한 관찰·교훈. empirical-* 패턴은 특정 사건 이후에도 반복해서 유용한 일반적 원칙을 담는다.

## 핵심 학습

### 1. PoC 증거가 설계 제안을 이긴다

초기 제안은 TypeScript·Go 양쪽 계약을 모두 자동 생성하는 방향이었지만, PoC에서 Go 생성물의 필드 태그 불일치·타입 매핑 오류·빈 구조체 처리 결함이 드러났다. 그 결과 계약 생성 전략은 TS 자동 생성 + Go 수작업 하이브리드로 바뀌었다.

원칙: 도구 선택은 설계 선호보다 실측 생성물 품질을 우선한다.

### 2. Facade는 codegen 교체 비용을 막는다

generated TS 파일을 도입해도 외부 import 경로가 흔들리지 않도록 `packages/shared/src/contracts/` facade가 내부 생성물을 감쌌다. 이 구조는 codegen 도구 교체나 버전 업그레이드가 제품 코드 전반으로 번지는 것을 막는 완충층이다.

원칙: generated 코드는 직접 노출하지 말고 안정된 facade 뒤에 둔다.

### 3. Race condition은 추정이 아니라 wire 증거로 닫는다

SIGTERM close code race에서는 signal handling 위치를 바꾸는 정적 분석만으로 실제 close code 경로를 판정할 수 없었다. 동시성 버그에서는 실행 컨텍스트 변경이 유용한 진단 도구일 수 있지만, 최종 판단은 raw socket·pcap 같은 wire 측정으로 내려야 한다.

원칙: race 진단에서 확률 추정은 참고만 하고 실제 측정으로 검증한다.

### 4. 통합 테스트 cut line은 핵심 가치와 알려진 한계를 분리해야 한다

핵심 산출물이 기능적으로 완성되고 남은 문제가 원인 분석과 backlog로 명문화되어 있다면, 모든 통합 항목을 같은 수준의 릴리스 블로커로 취급하지 않는다. 다만 단위·통합 테스트 PASS가 end-user 경로 검증을 대체하지는 못한다.

원칙: 알려진 한계는 명시적으로 이연하되, 실제 사용자 경로의 dev launch smoke를 cut line에 포함한다.

## 관련 문서

- `.nexus/context/roadmap.md`: M3 Harness Observer 마일스톤
- `.nexus/context/stack.md`: Codegen·WebSocket 묶음 정책
- `.nexus/memory/pattern-sidecar-close-code-race.md`: race 진단 레시피
- `.nexus/memory/pattern-dev-launch-verification.md`: dev launch 검증 패턴
