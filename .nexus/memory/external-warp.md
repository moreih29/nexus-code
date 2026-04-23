# external-warp

스냅샷 날짜: 2026-04

## 포지셔닝

Rust + GPU 렌더러 기반 AI 내장 터미널로, Agent Mode(Claude 4 Sonnet)와 자체 코드 에디터를 통합해 터미널에서 IDE급 경험을 지향.

## 워크스페이스 모델

탭·패인 기반 터미널 세션 관리. 워크스페이스={에디터+터미널+AI 세션+git} 원자적 격리 모델 없음. 프로젝트 단위 전환 개념 미확인.

## AI 하네스 통합 방식

Agent Mode를 자체 제품으로 내장(Claude 4 Sonnet 연동). 외부 AI 하네스(claude-code, opencode, codex 등)를 관찰·오케스트레이션하는 어댑터 구조 없음. AI 교체·병행 운용 불가.

## IDE 기능 수준

Warp Code(자체 코드 에디터)·LSP 통합 확장 중. 파일트리·git UI는 부분 지원 추정. 마크다운 프리뷰·웹뷰는 미확인. VSCode 수준 IDE 기능 완전성 미달.

## 터미널 통합 수준

Rust + Metal/wgpu GPU 렌더러 기반 자체 터미널. 블록 기반 출력 UI, 자연어 명령 변환, AI 인라인 제안 등 독자적 UX. 성능 우수하나 타사 PTY 표준과 호환성 차이 존재.

## CJK/한글 렌더링 상태

다수 미해결 이슈 확인:

- IME lag (이슈 #6749)
- 자모 분리(이슈 #3127)
- Enter 오작동 — 조합 중 Enter가 submit 처리(이슈 #6591, #6891, #7436)
- 추가 CJK 관련 이슈 다수 open 상태

공식 수정 일정 미확인. 한국어 일상 사용 환경에서 신뢰성 낮음.

## 기술 스택

- 언어: Rust
- 렌더러: Metal(macOS) / wgpu(크로스플랫폼)
- 에디터: 자체 Warp Code (Monaco 기반 여부 미확인)
- AI: Claude 4 Sonnet (Agent Mode 내장)
- 플랫폼: macOS, Linux, Windows(베타 추정)

## 오픈소스 여부·라이선스

비공개 독점 소프트웨어. 소스 미공개.

## nexus-code 비전 대비 미충족 지점

한국어 IME 다수 미해결 버그로 CJK 품질 미충족. 외부 AI 하네스 관찰·교체 모델 없이 자사 AI에 종속되어 claude-code/opencode/codex 병행 운용 불가.

## 출처

- https://www.warp.dev
- https://docs.warp.dev
- https://github.com/warpdotdev/Warp/issues (CJK 이슈 번호는 이 트래커 기준, 2026-04 당시 확인치로 개별 번호 직접 검증은 진행 필요)
