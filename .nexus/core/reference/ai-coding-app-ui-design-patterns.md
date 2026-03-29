<!-- tags: ui-design, dark-theme, cursor, windsurf, warp, zed, claude-desktop, chatgpt, tool-call-display, panel-layout -->
# AI 코딩 어시스턴트 데스크톱 앱 UI 디자인 패턴

**Date searched**: 2026-03-29
**Full report**: `.nexus/state/artifacts/ui-design-research.md`

---

## 다크 테마 색상 — 핵심 수치

| 앱 | 배경 | 텍스트 | 강조색 |
|---|---|---|---|
| Cursor | `#1E1E1E` (VS Code 계열) | `#D4D4D4` | 테마 의존 |
| Windsurf | aqua/teal 계열 | 40~100% 불투명도 계층 | `sk-aqua` 토큰 |
| Warp | 어두운 단색 + 흰 오버레이 | `rgba(250,249,246)` | 단일 Accent |
| Claude Desktop | 다크 모드 선택 | — | 퍼플 계열 |
| ChatGPT Desktop | `#212121` | `#E0E0E0` ~ `#FAFAFA` | — |

Zed은 hex 값 미공개 — `theme_overrides`로 추상화됨.

---

## 도구 호출 표시 방식 비교

- **Cursor**: Compact(접힘+아이콘숨김) / Full(펼침) 두 모드. 체크포인트 복원 버튼.
- **Windsurf**: 파일 추적 배지 + 터미널 로그 + 상태 pill + 컨텍스트 크기 인디케이터.
- **Warp**: 블록(Block) = 명령+출력 원자 단위. 에러 시 빨간 배경 자동. Sticky Header.
- **Zed**: 스트리밍 인디케이터 + 크로스헤어(파일 점프). Text Thread 모드(도구 없는 순수 채팅).
- **Claude Desktop**: Artifacts 카드 → 클릭 시 우측 패널 확장.
- **ChatGPT**: 코드블록만, 아티팩트 시스템 없음.

---

## 패널 레이아웃 패턴

- **2패널 기본** (채팅 + 에디터): Cursor, Windsurf, Zed
- **3패널 동적 전환** (사이드바 + 채팅 + 우측 컨텍스트): Claude Desktop (Artifacts)
- **블록 스트림** (터미널 패러다임): Warp
- **미니멀 2열** (사이드바 + 채팅): ChatGPT Desktop

---

## Claude Code GUI 래퍼 적용 권장 색상

```
주 배경:    #0d0d0d ~ #141414
패널 배경:  #1a1a1a ~ #1e1e1e
블록 배경:  #252525 ~ #2a2a2a
주 텍스트:  #e8e6e1
보조 텍스트:#888888
강조:       #cc785c (Claude 오렌지)
성공:       #4ade80
오류:       #f87171
대기:       #fbbf24
```

---

## 소스 URL

- Cursor Docs: https://cursor.com/docs/agent/overview
- Windsurf Cascade: https://windsurf.com/cascade
- Warp Blocks: https://docs.warp.dev/terminal/blocks/block-basics
- Warp Theme Design: https://www.warp.dev/blog/how-we-designed-themes-for-the-terminal-a-peek-into-our-process
- Zed Agent Panel: https://zed.dev/docs/ai/agent-panel
- Claude Artifacts: https://support.claude.com/en/articles/11649427-use-artifacts-to-visualize-and-create-ai-apps-without-ever-writing-a-line-of-code
- AI UI Comparison 2025: https://intuitionlabs.ai/articles/conversational-ai-ui-comparison-2025
- Claude Code GUI Tools 2026: https://nimbalyst.com/blog/best-claude-code-gui-tools-2026/
