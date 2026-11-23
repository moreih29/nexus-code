import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import { titleOf } from "../../../../src/renderer/services/chat/tab-title";
import { noteTaskPrompt } from "../../../../src/renderer/services/notes/task";
import { noteLabel, shownNoteText } from "../../../../src/shared/notes/line-report";

const mention = "Note ‘Review’: `nexus note read n1234567`";
const written = [
  String.raw`"C:\new folder\temp"`,
  String.raw`"C:\\Users\\kih"`,
  String.raw`"a\"b"`,
  String.raw`"\u003cb\u003e"`,
];

describe("shownNoteText", () => {
  test("quoted text a person wrote next to a note mention stays as written", () => {
    for (const quoted of written) {
      const message = `${quoted} 확인해 줘\n\n${mention}`;
      expect(shownNoteText(message)).toBe(message);
    }
  });

  test("a to-do prompt's labels show their own characters", () => {
    const item = 'Fix <App> {{id}} "quotes" 🚀 한글';
    const title = 'Plan <b> {x} "Q" 🎉 회의';
    const heading = "결정 <사항>";
    const prompt = noteTaskPrompt(item, title, heading, "n1234567");
    expect(prompt.split("\n").slice(0, 2).join("\n")).not.toMatch(/[<>{}]/);
    const shown = shownNoteText(prompt).split("\n");
    expect(shown[0]).toBe(`To-do: "${item}"`);
    expect(shown[1]).toBe(
      `Note "${title}" · Under "${heading}" · Read the full note with \`nexus note read n1234567\`.`,
    );
    expect(shown[2]).toContain('`nexus note report --done "one-line summary"');
  });

  test("a to-do prompt written in Korean shows its labels the same way", () => {
    const t = i18next.getFixedT("ko", "notes");
    const interpolation = { escapeValue: false, skipOnVariables: true };
    const prompt = [
      t("tasks.promptItem", { text: noteLabel("<태그> {{id}}", "", Infinity), interpolation }),
      t("tasks.promptNote", {
        title: noteLabel('주간 "회의"'),
        section: t("tasks.promptSection", { heading: noteLabel("{결정}"), interpolation }),
        id: "n1234567",
        interpolation,
      }),
    ].join("\n");
    expect(shownNoteText(prompt)).toBe(
      '할 일: "<태그> {{id}}"\n노트 "주간 "회의"" · "{결정}" 아래 · `nexus note read n1234567`로 전체를 읽어 주세요.',
    );
  });

  test("a to-do's own backslashes and quotes show as written in the note", () => {
    const item = String.raw`Check "C:\new folder\temp" and C:\\Users`;
    const shown = shownNoteText(noteTaskPrompt(item, "Plan", "", "n1234567"));
    expect(shown.split("\n")[0]).toBe(`To-do: "${item}"`);
  });

  test("a person's quoted text in the same message as the app's labels stays as written", () => {
    const prompt = noteTaskPrompt("Run <tests>", "Plan {x}", "", "n1234567");
    const message = `${prompt}\n${written.join(" ")}\n${mention}`;
    const shown = shownNoteText(message).split("\n");
    expect(shown.slice(0, 2)).toEqual([
      'To-do: "Run <tests>"',
      'Note "Plan {x}" · Read the full note with `nexus note read n1234567`.',
    ]);
    expect(shown.at(-2)).toBe(written.join(" "));
    expect(shown.at(-1)).toBe(mention);
  });

  test("a to-do line a person typed keeps escapes the app would not have written", () => {
    for (const quoted of [String.raw`"C:\new folder\temp"`, String.raw`"\u0041"`, '"<b>"']) {
      const message = `To-do: ${quoted}\n${mention}`;
      expect(shownNoteText(message)).toBe(message);
    }
  });
});

describe("titleOf", () => {
  test("a first message with a note mention keeps the quoted text as written", () => {
    const first = `${String.raw`"tab\new line\temp"`} 확인해 줘`;
    expect(titleOf(`${first}\n\n${mention}`)).toBe(first);
  });

  test("a to-do prompt's title shows the to-do's own characters", () => {
    expect(titleOf(noteTaskPrompt("Fix <App> {x} 한글", "Plan", "", "n1234567"))).toBe(
      'To-do: "Fix <App> {x} 한글"',
    );
  });
});
