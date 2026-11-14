import { describe, expect, test } from "bun:test";
import { type DocNode, docToMarkdown, escapeText } from "../../../../src/shared/notes/markdown";

const p = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]): DocNode => ({
  type: "text",
  text,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const doc = (...content: DocNode[]): DocNode => ({ type: "doc", content });

describe("a note as Markdown", () => {
  test("an empty note is empty", () => {
    expect(docToMarkdown(doc())).toBe("");
    expect(docToMarkdown(doc(p()))).toBe("");
    expect(docToMarkdown(null)).toBe("");
  });

  test("headings, paragraphs and marks", () => {
    const md = docToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [t("계획")] },
        p(t("굵게", "bold"), t(" 그리고 "), t("코드", "code"), t(" "), t("기울임", "italic")),
        p({
          type: "text",
          text: "search.ts",
          marks: [{ type: "link", attrs: { href: "workspace:src/search.ts" } }],
        }),
      ),
    );
    expect(md).toBe(
      "## 계획\n\n**굵게** 그리고 `코드` *기울임*\n\n[search.ts](workspace:src/search.ts)\n",
    );
  });

  test("lists, nested, numbered and to-dos", () => {
    const li = (...content: DocNode[]): DocNode => ({ type: "listItem", content });
    const md = docToMarkdown(
      doc(
        {
          type: "bulletList",
          content: [
            li(p(t("하나")), { type: "bulletList", content: [li(p(t("안쪽")))] }),
            li(p(t("둘"))),
          ],
        },
        { type: "orderedList", attrs: { start: 3 }, content: [li(p(t("셋"))), li(p(t("넷")))] },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: true }, content: [p(t("끝남"))] },
            { type: "taskItem", attrs: { checked: false }, content: [p(t("남음"))] },
          ],
        },
      ),
    );
    expect(md).toBe("- 하나\n  - 안쪽\n- 둘\n\n3. 셋\n4. 넷\n\n- [x] 끝남\n- [ ] 남음\n");
  });

  test("quotes, code and rules", () => {
    const md = docToMarkdown(
      doc(
        { type: "blockquote", content: [p(t("인용"))] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [t("const a = 1;")] },
        { type: "horizontalRule" },
      ),
    );
    expect(md).toBe("> 인용\n\n```ts\nconst a = 1;\n```\n\n---\n");
  });

  test("sketches, images and files point into the note's folder", () => {
    const md = docToMarkdown(
      doc(
        { type: "sketch", attrs: { src: "sketches/s1.svg", title: "캐시 흐름" } },
        { type: "noteImage", attrs: { src: "screens/a.png", alt: "검색 결과" } },
        {
          type: "noteFile",
          attrs: { src: "materials/0.4.0 제안서.pdf", name: "0.4.0 제안서.pdf" },
        },
      ),
    );
    expect(md).toBe(
      "![캐시 흐름](sketches/s1.svg)\n\n![검색 결과](screens/a.png)\n\n[0.4.0 제안서.pdf](<materials/0.4.0 제안서.pdf>)\n",
    );
  });

  test("text that reads as markup is escaped", () => {
    expect(escapeText("# 아님")).toBe("\\# 아님");
    expect(escapeText("1. 아님")).toBe("1\\. 아님");
    expect(escapeText("a*b*_c_ [x]")).toBe("a\\*b\\*\\_c\\_ \\[x\\]");
    expect(docToMarkdown(doc(p(t("a", "code"), t(" "), t("x`y", "code"))))).toBe("`a` `` x`y ``\n");
  });

  test("a hard break stays a line break", () => {
    expect(docToMarkdown(doc(p(t("위"), { type: "hardBreak" }, t("아래"))))).toBe("위  \n아래\n");
  });
});
