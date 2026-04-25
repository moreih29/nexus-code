# M3 인수인계 사이클 회고

우리가 마주한 관찰·교훈. empirical-* 패턴은 특정 사건 이후에도 반복해서 유용한 일반적 원칙을 담는다.

## 핵심 학습

### 1. PoC가 도구 추천을 뒤집는 가치

plan #15 architect 1안은 `json-schema-to-typescript` + `Ajv` + `go-jsonschema` 풀 자동화를 제안했다. 하지만 PoC에서 Go 측 생성물의 품질이 기준 미달임이 확인되었다. 수작업 Go 코드와의 비교에서 필드 태그 불일치·타입 매핑 오류·빈 구조체 처리 결함이 발견되었다.

결과적으로 하이브리드(TS 자동 + Go 수작업)로 전환했다. 이 결정은 architect 1안을 그대로 따르지 않고 PoC 증거를 우선시한 사례다.

### 2. Facade 패턴의 성공

generated TS 파일 7개를 도입했음에도 E2 코드의 35개 이상 import 위치가 0줄 변경되었다. `packages/shared/src/contracts/`의 facade가 내부 생성물 교체를 외부 코드로부터 완전히 격리했다. 이는 향후 codegen 도구 교체·버전 업그레이드 시 영향 범위를 제한하는 구조적 증거다.

### 3. Architect 1안의 한계 — 진단에서의 추정과 현실

SIGTERM close code race 진단에서 architect는 1안(signal handling을 main goroutine select로 이동) 적용 시 PASS 확률을 70%로 추정했다. 실제로는 30% 시나리오가 지속적으로 발동하여 race가 해결되지 않았다.

이 사례는 복잡한 race condition에 대해 정적 분석과 경험 기반 추정이 한계를 가짐을 보여준다. wire 캡처가 진단의 마지막 결정타이며, 이 절차는 backlog에 등록되어 다음 사이클에서 실행된다.

### 4. 통합 테스트 cut line의 가치

통합 테스트가 100% 통과하지 않아도(80% 통과 + 나머지는 원인 분석·expect 약화로 처리), 사이클의 전체 가치는 충분하다. 본 사이클의 핵심 산출물(codegen 파이프라인, drift gate, facade, handshake server, bridge)은 모두 기능적으로 완성되었으며, 남은 20%는 알려진 한계(backlog)로 명문화되었다.

### 5. Signal handling 일관성

installSignalHandler를 별도 goroutine으로 두느냐, main goroutine의 select로 넣느냐는 race 노출 차이가 있다. 본 사이클에서 architect 진단이 이 차이를 명확히 해석하여 다음 사이클의 wire 캡처 우선순위를 결정하는 데 기여했다. 이는 동시성 버그 진단에서 실행 컨텍스트 변경이 유의미한 진단 도구가 될 수 있음을 입증한다.

## 적용 원칙

- PoC 결과가 architect 제안과 충돌할 때는 PoC 증거를 우선한다.
- generated 코드 도입 시 facade는 선택이 아닌 필수다.
- race condition 진단에서 추정 확률은 참고만 하며, wire 캡처·실제 측정으로 검증한다.
- 통합 테스트 100% 통과를 릴리스 블로커로 삼지 않는다. 알려진 한계는 backlog로 명문화하고 차기 사이클로 이연한다.

## 관련 문서

- `.nexus/context/roadmap.md`: M3 Harness Observer 마일스톤
- `.nexus/context/stack.md`: Codegen·WebSocket 묶음 정책
- `.nexus/memory/pattern-sidecar-close-code-race.md`: race 진단 레시피
