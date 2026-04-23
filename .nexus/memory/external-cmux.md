# external-cmux

스냅샷 날짜: 2026-04

## 포지셔닝

macOS 전용 터미널 멀티플렉서로, AI 에이전트 알림·시각화에 특화된 네이티브 창 관리자.

## 워크스페이스 모델

수평·수직 패인 분할 방식. 워크스페이스를 {에디터 상태 + 파일트리 + 터미널 + AI 세션 + git 상태}로 묶는 원자적 단위 개념 없음. 세션 지속성 없음(프로세스 종료 시 상태 소멸).

## AI 하네스 통합 방식

Unix 소켓 + Claude Code hook 기반으로 AI 에이전트 이벤트를 수신해 패인에 알림·시각화 오버레이로 표시. TUI를 대체하지 않고 읽기 전용 관찰(observer) 방식. AI 에이전트 실행 자체는 터미널 PTY에 위임.

## IDE 기능 수준

IDE 기능 전무. 에디터·LSP·파일트리·git UI·마크다운 프리뷰·웹뷰 중 어느 것도 제공하지 않음. 순수 터미널 멀티플렉서.

## 터미널 통합 수준

libghostty 기반 GPU 가속 터미널. 수평/수직 패인 분할, 복수 터미널 창. 터미널 자체 품질은 높으나 워크스페이스별 독립 세션 관리나 스크롤백 보존 정책은 미확인.

## CJK/한글 렌더링 상태

libghostty(Ghostty) 기반이므로 CJK 렌더링 품질은 Ghostty 수준으로 추정. 한글 IME 조합 중 커서 위치, 자모 분리 버그 여부는 미확인. 공식 CJK 지원 표명 없음.

## 기술 스택

- 언어: Swift (macOS 네이티브)
- 터미널 라이브러리: libghostty
- AI 연동: Unix 소켓 + Claude Code hooks API
- 플랫폼: macOS 전용

## 오픈소스 여부·라이선스

오픈소스. MIT 라이선스. GitHub: [github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)

## nexus-code 비전 대비 미충족 지점

IDE 기능(에디터·LSP·마크다운·웹뷰)이 전혀 없어 VSCode급 코딩 경험을 제공하지 못함. 세션 지속성 없음으로 워크스페이스 전환 후 AI 대화 이력·터미널 상태 복원 불가.

## 출처

- https://github.com/manaflow-ai/cmux
