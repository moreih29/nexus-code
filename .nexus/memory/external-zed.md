# external-zed

스냅샷 날짜: 2026-04

## 포지셔닝

Rust + GPUI 기반 네이티브 코드 에디터로, ACP(Agent Client Protocol)를 통해 외부 AI 에이전트를 일급 시민으로 연결하는 협업 지향 IDE.

## 워크스페이스 모델

멀티 워크스페이스 지원을 진행 중이나 UX 미성숙. 복수 프로젝트 간 저장·전환 요청 상태(이슈 #52533 / Discussion #7194). 워크스페이스={에디터+터미널+AI 세션+git} 원자적 격리 모델 미구현.

## AI 하네스 통합 방식

ACP(Agent Client Protocol) 표준 인터페이스로 외부 에이전트 연결. 에이전트 교체·병행 운용 구조 지향. 단, 각 에이전트별 어댑터 구현 깊이는 미확인. 자체 AI 추론 엔진 없음.

## IDE 기능 수준

풍부한 IDE 기능 제공. Tree-sitter 파싱 기반 구문 강조·코드 네비게이션, LSP 통합, 파일트리, 멀티 커서, 협업 편집(Zed Channels). 마크다운 프리뷰 지원. 웹뷰 지원 여부 미확인. git UI 기본 제공.

## 터미널 통합 수준

Alacritty 기반 임베드 터미널 제공. PTY 통합으로 에디터 내 터미널 실행 가능. 워크스페이스별 독립 터미널 세션 격리 정책은 미확인.

## CJK/한글 렌더링 상태

Windows 환경 CJK IME 미해결 이슈 다수(이슈 #40335 등). macOS 한글 IME 상태는 미확인. GPUI 기반 자체 렌더러이므로 플랫폼별 IME 통합 품질 편차 존재. 공식 CJK 지원 표명 없음.

## 기술 스택

- 언어: Rust
- UI 프레임워크: GPUI (자체 개발)
- 터미널: Alacritty 기반
- 파싱: Tree-sitter
- AI 프로토콜: ACP (Agent Client Protocol)
- 플랫폼: macOS, Linux (Windows 베타)

## 오픈소스 여부·라이선스

오픈소스. AGPL v3(에디터 코어) + Apache 2.0(라이브러리) + MIT(일부 컴포넌트) 혼합 라이선스. GitHub: [github.com/zed-industries/zed](https://github.com/zed-industries/zed)

## nexus-code 비전 대비 미충족 지점

멀티 워크스페이스 원자적 전환(에디터+터미널+AI 세션 묶음) 미구현으로 단일 창 프로젝트 전환 UX 미충족. CJK IME 품질 편차로 한국어 일상 사용 보장 불가.

## 출처

- https://zed.dev
