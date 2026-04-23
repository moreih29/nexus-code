# external-cursor-windsurf

스냅샷 날짜: 2026-04

> Cursor와 Windsurf는 모두 VSCode fork 기반 AI 코드 에디터이며 구조적 유사점이 높아 한 파일에 통합 정리.

---

## Cursor

### 포지셔닝

VSCode fork + Shadow Workspace 아키텍처로 자체 Composer/Tab/Agent AI 기능을 통합한 AI 우선 코드 에디터.

### 워크스페이스 모델

VSCode 기반 단일 프로젝트 폴더 모델. 프로젝트 단위 세션 격리 없음. 복수 프로젝트 병행 시 창 분리 필요. Shadow Workspace는 AI 백그라운드 작업용 내부 구조이며 사용자 대면 워크스페이스 전환 UX 아님.

### AI 하네스 통합 방식

자체 Composer(멀티 파일 편집), Tab(인라인 자동완성), Agent(자율 코딩) 기능 내장. 외부 AI 하네스(claude-code, opencode, codex 등) 관찰·어댑터 구조 없음. 모델은 Claude·GPT-4·Gemini 등 선택 가능하나 하네스 교체 개념 아님.

### IDE 기능 수준

VSCode 기반으로 에디터·LSP·파일트리·git·마크다운 프리뷰·웹뷰 모두 VSCode 수준 제공. 확장 생태계 일부 호환(VSCode 마켓플레이스 일부 제한).

### 터미널 통합 수준

VSCode 내장 터미널(xterm.js + node-pty) 그대로 상속. 워크스페이스별 독립 터미널 세션 격리 없음.

### CJK/한글 렌더링 상태

IME Enter submit 버그 보고 다수(forum.cursor.com). 조합 중 Enter가 줄바꿈과 submit을 동시에 실행하는 오작동. Electron + VSCode 구조 상속으로 xterm.js IME 이슈 동반 가능성 있음. 공식 해결 일정 미확인.

### 기술 스택

- 기반: Electron + Monaco (VSCode fork)
- AI: 자체 Composer/Tab/Agent, 다중 모델 지원
- 플랫폼: macOS, Windows, Linux

### 오픈소스 여부·라이선스

비공개 독점 소프트웨어.

### nexus-code 비전 대비 미충족 지점

프로젝트 단위 워크스페이스 격리(에디터+터미널+AI 세션 묶음) 없음. 외부 AI 하네스 관찰·병행 운용 불가(자사 AI 기능에 종속). 한국어 IME Enter 버그 미해결.

### 출처

- https://www.cursor.com
- https://forum.cursor.com

---

## Windsurf

### 포지셔닝

VSCode fork + Cascade 에이전트와 자체 SWE-1.5 모델로 자율 코딩 중심 UX를 제공하는 AI 코드 에디터.

### 워크스페이스 모델

VSCode 기반 단일 프로젝트 폴더 모델. Cursor와 동일하게 프로젝트 단위 세션 격리 없음.

### AI 하네스 통합 방식

Cascade 에이전트(자율 멀티 스텝 코딩) 내장. 자체 SWE-1.5 모델 포함. Codemaps로 코드베이스 시각 네비게이션 제공. 외부 AI 하네스 어댑터 구조 없음.

### IDE 기능 수준

VSCode 기반으로 에디터·LSP·파일트리·git·마크다운 프리뷰·웹뷰 모두 VSCode 수준 제공. Codemaps(코드베이스 시각화 네비게이션)가 추가 차별 기능.

### 터미널 통합 수준

VSCode 내장 터미널 상속. 워크스페이스별 독립 터미널 세션 격리 없음.

### CJK/한글 렌더링 상태

VSCode fork 구조 상속으로 xterm.js IME 이슈 동반 가능성 있음(추정). Windsurf 전용 CJK 이슈 보고 여부 미확인.

### 기술 스택

- 기반: Electron + Monaco (VSCode fork)
- AI: Cascade 에이전트, 자체 SWE-1.5 모델
- 플랫폼: macOS, Windows, Linux

### 오픈소스 여부·라이선스

비공개 독점 소프트웨어.

### nexus-code 비전 대비 미충족 지점

프로젝트 단위 워크스페이스 격리 없음. 자사 Cascade/SWE-1.5에 종속되어 외부 AI 하네스(claude-code, opencode, codex)를 네이티브 터미널처럼 운용하는 구조 제공 불가.

### 출처

- https://windsurf.com
