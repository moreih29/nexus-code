import { describe, expect, it } from "bun:test";
import {
  hangingIndents,
  listMarkerCss,
} from "../../../../../../src/renderer/components/editor/preview/docx-lists";

// As docx-preview writes a numbering's rules.
const CSS = [
  'p.docx-num-1-0:before {\r\n  content: ""counter(docx-num-1-0, decimal)".\\9";\r\n  counter-increment: docx-num-1-0;\r\n}',
  "p.docx-num-1-0 {\r\n  display: list-item;\r\n  text-indent: -20.00pt;\r\n  margin-inline-start: 20.00pt;\r\n}",
  'p.docx-num-1-1:before {\r\n  content: "-\\a0";\r\n  counter-increment: docx-num-1-1;\r\n}',
  "p.docx-num-1-1 {\r\n  text-indent: -18.00pt;\r\n  margin-inline-start: 72.00pt;\r\n}",
  'p.docx-num-1-2:before {\r\n  content: "•\\9";\r\n}',
  "p.docx-num-1-2 {\r\n  text-indent: 0.00pt;\r\n  margin-inline-start: 36.00pt;\r\n}",
].join("\r\n");

describe("hangingIndents", () => {
  it("reads each level's hanging indent off its paragraphs' negative text-indent", () => {
    expect([...hangingIndents(CSS)]).toEqual([
      ["docx-num-1-0", "20.00pt"],
      ["docx-num-1-1", "18.00pt"],
    ]);
  });
});

describe("listMarkerCss", () => {
  it("sets a marker ending in a tab as wide as its hanging indent, without the tab", () => {
    const fixed = listMarkerCss(CSS, hangingIndents(CSS));
    expect(fixed).toContain(
      'p.docx-num-1-0:before {\r\n  content: ""counter(docx-num-1-0, decimal)".";\r\n  counter-increment: docx-num-1-0;\r\n display: inline-block; box-sizing: border-box; min-width: 20.00pt; padding-right: 0.5em; text-indent: 0; }',
    );
  });

  it("leaves a marker followed by a space, or with no hanging indent", () => {
    const fixed = listMarkerCss(CSS, hangingIndents(CSS));
    expect(fixed).toContain(
      'p.docx-num-1-1:before {\r\n  content: "-\\a0";\r\n  counter-increment: docx-num-1-1;\r\n}',
    );
    expect(fixed).toContain('p.docx-num-1-2:before {\r\n  content: "•\\9";\r\n}');
  });
});
