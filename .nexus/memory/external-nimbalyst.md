# external-nimbalyst

스냅샷 날짜: 2026-04

## 포지셔닝

Claude Code·Codex CLI를 감싸는 GUI wrapper로, 세션 칸반과 멀티 에디터(Monaco·마크다운·Excalidraw) 조합으로 AI 코딩 세션을 시각적으로 관리하는 제품.

## 워크스페이스 모델

세션 칸반 보드 방식. AI 세션을 칸반 카드 단위로 시각적 배치·관리. {에디터+터미널+AI 세션+git}을 원자적으로 묶는 워크스페이스 전환 모델인지는 미확인. 프로젝트 간 즉시 전환 UX 존재 여부 미확인.

## AI 하네스 통합 방식

Claude Code·Codex CLI를 프로세스 수준에서 래핑해 GUI로 노출. TUI를 대체하는 자체 채팅·편집 UI 제공 방식으로 추정. 외부 하네스 관찰(observer) 패턴인지 TUI 대체 패턴인지 미확인.

## IDE 기능 수준

Monaco 에디터·마크다운 WYSIWYG·Excalidraw(다이어그램) 멀티 에디터 지원. LSP 통합 여부 미확인. 파일트리·git UI 지원 여부 미확인. 웹뷰 지원 미확인. VSCode 수준 IDE 기능 완전성 미달로 추정.

## 터미널 통합 수준

터미널 네이티브 경험 약함으로 평가(plan.json 연구 요약 기준). 네이티브 PTY 터미널 탭 지원 여부 미확인. AI CLI를 GUI로 추상화하는 방향이므로 터미널 직접 노출이 제한적일 것으로 추정.

## CJK/한글 렌더링 상태

공식 CJK 지원 언급 없음. Monaco 에디터 자체는 CJK 렌더링 가능하나, 래핑 레이어(CLI 프로세스 출력 처리, 입력 전달)에서 한글 IME 조합 품질은 미확인.

## 기술 스택

- 런타임: Electron 기반으로 추정 (공식 미확인, 기술 스택 불투명)
- 에디터: Monaco + 마크다운 WYSIWYG + Excalidraw
- AI 연동: Claude Code·Codex CLI 프로세스 래핑
- 보안 인증: SOC 2 Type 2 획득

## 오픈소스 여부·라이선스

비공개 독점 소프트웨어. 소스 미공개.

## nexus-code 비전 대비 미충족 지점

터미널 네이티브 경험이 약하고 기술 스택이 불투명해 장기 안정성·확장성 판단 불가. AI 하네스를 관찰(observer)하되 TUI를 보존하는 방식이 아닌 GUI 대체 방향으로 추정되어, 네이티브 터미널 수준의 AI 하네스 사용성이라는 nexus-code 핵심 목표와 접근 방식이 다름.

## 출처

- https://nimbalyst.com/features
