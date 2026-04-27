# external-competitors

스냅샷 날짜: 2026-04

cmux: macOS 전용 터미널 멀티플렉서 겸 AI 에이전트 관찰 도구. Unix 소켓+Claude Code hooks로 TUI를 대체하지 않고 알림·오버레이만 붙이는 점이 차별점이며, nexus-code의 observer 패턴과 즉시 전환 UX 기준에 영향을 줬다.

Cursor/Windsurf: VSCode fork 기반 AI 코드 에디터 계열. Cursor는 Composer/Tab/Agent, Windsurf는 Cascade·SWE-1.5와 Codemaps가 차별점이나 외부 하네스 어댑터와 프로젝트별 원자 워크스페이스 격리는 약하다. nexus-code는 VSCode급 IDE 기능은 수용하되 하네스 종속과 IME 취약성은 피한다.

Warp: Rust+GPU 렌더러 기반 AI 터미널. 블록 출력, 자연어 명령, Agent Mode와 Warp Code가 차별점이나 외부 하네스 병행 운용보다 자사 AI 중심이며 CJK/한글 IME 이슈가 많다. nexus-code는 터미널 성능보다 한국어 입력 안정성과 하네스 교체성을 우선한다.

Zed: Rust+GPUI 네이티브 IDE. ACP로 외부 AI 에이전트를 일급 연결하는 점이 가장 가까운 선행 사례이나, 원자적 멀티 워크스페이스 전환과 플랫폼별 CJK IME 품질은 미성숙하다. nexus-code는 ACP식 어댑터 방향을 참고하되 워크스페이스 격리를 핵심 요구로 둔다.

Nimbalyst: Claude Code·Codex CLI를 감싸는 GUI 세션 보드/멀티 에디터 제품. 칸반, Monaco, 마크다운, Excalidraw 조합이 차별점이나 터미널 네이티브 경험과 기술 투명성이 약하다. nexus-code는 GUI 대체보다 TUI/PTY를 보존하는 observer형 통합을 택한다.
