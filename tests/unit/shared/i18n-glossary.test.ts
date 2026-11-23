import { describe, expect, test } from "bun:test";
import { I18N_NAMESPACES, resources } from "../../../src/shared/i18n/index";

function leaves(value: unknown, prefix: string): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix.endsWith(":") ? `${prefix}${key}` : `${prefix}.${key}`),
  );
}

function strings(locale: "en" | "ko"): Map<string, string> {
  return new Map(I18N_NAMESPACES.flatMap((ns) => leaves(resources[locale][ns], `${ns}:`)));
}

const en = strings("en");
const ko = strings("ko");

const SAME_ENGLISH_EXCEPTIONS: Readonly<Record<string, string>> = {
  Block: "a permission answer (차단) and a cursor shape (블록)",
  Default: "a named default such as a profile or shell (기본) and a default value (기본값)",
  "Never ask": "the bypass mode's hint (아무것도 묻지 않음) and Codex's approval value (묻지 않기)",
  Off: "a state (꺼짐) and a choice (끄기)",
  Remove: "removing an item (제거) and unpairing a device (해제)",
  "Remove {{name}}": "removing an item (제거) and unpairing a device (해제)",
  "Remove {{name}}?": "removing an item (제거) and unpairing a device (해제)",
  Results: "a conversation's outputs (결과물) and where a profile rule applies (적용 결과)",
  Thinking: "a thinking block (생각) and the working state (생각 중)",
  Undo: "undoing a note edit (되돌리기) and the editor's undo key (실행 취소)",
  Window: "the macOS Window menu (윈도우) and the app window (창)",
};

const FORBIDDEN: readonly { word: RegExp; use: string; allowed: readonly string[] }[] = [
  { word: /채팅/, use: "대화", allowed: [] },
  {
    word: /세션/,
    use: "대화",
    allowed: [
      "common:ssh.error.session_expired",
      "common:terminal.held_banner",
      "common:panel.session_expired",
      "common:panel.session_expired_desc",
      "common:chat.usage.kind.session",
      "common:chat.usage.short.session",
      "settings:dialog.modifiedTitle",
      "settings:keybindings.section.editorDescription",
    ],
  },
  { word: /분기/, use: "포크", allowed: [] },
  { word: /태스크/, use: "작업", allowed: [] },
  { word: /작업 ?공간|워크 스페이스/, use: "워크스페이스", allowed: [] },
  {
    word: /재개|이어 하기|이어서 하기/,
    use: "이어하기",
    allowed: ["settings:keybindings.reservedNote.flowResume"],
  },
  { word: /하십시오/, use: "하세요", allowed: [] },
  { word: /새로고침/, use: "새로 고침", allowed: [] },
  { word: /지시사항/, use: "지시", allowed: [] },
  { word: /에디터/, use: "편집기", allowed: [] },
  { word: /에이전트 뷰/, use: "에이전트 보기", allowed: [] },
  { word: /전체 접근/, use: "전체 권한", allowed: [] },
  {
    word: /\}\}["'“”‘’]?(\((을|를|이|가|은|는|과|와|으)\)|(을|를|이|가|은|는|과|와|으로|로)(?![가-힣]))/,
    use: "a sentence with no particle right after an interpolation",
    allowed: [],
  },
  {
    word: /\((을|를|이|가|은|는|과|와|으)\)/,
    use: "one particle that fits, or none",
    allowed: [],
  },
];

describe("the glossary", () => {
  test("one English text has one Korean text, apart from the listed exceptions", () => {
    const byEnglish = new Map<string, Set<string>>();
    for (const [key, text] of en) {
      const korean = ko.get(key);
      if (korean === undefined) continue;
      byEnglish.set(text, (byEnglish.get(text) ?? new Set()).add(korean));
    }
    const split = [...byEnglish]
      .filter(([, words]) => words.size > 1)
      .map(([text, words]) => ({ text, ko: [...words].sort() }));
    expect(split.filter(({ text }) => !(text in SAME_ENGLISH_EXCEPTIONS))).toEqual([]);
    expect(
      Object.keys(SAME_ENGLISH_EXCEPTIONS).filter((text) => !split.some((s) => s.text === text)),
    ).toEqual([]);
  });

  test("Korean texts use the glossary's words", () => {
    const wrong: string[] = [];
    for (const [key, text] of ko) {
      for (const rule of FORBIDDEN) {
        if (rule.word.test(text) && !rule.allowed.includes(key))
          wrong.push(`${key}: ${text} (use ${rule.use})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every allowed key still exists", () => {
    const missing = FORBIDDEN.flatMap((rule) => rule.allowed).filter((key) => !ko.has(key));
    expect(missing).toEqual([]);
  });
});
