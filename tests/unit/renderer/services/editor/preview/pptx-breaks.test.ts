import { describe, expect, it } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  breaksToRuns,
  LINE_BREAK,
  withLineBreaks,
} from "../../../../../../src/renderer/services/editor/preview/pptx-breaks";

const SLIDE = "ppt/slides/slide1.xml";

describe("breaksToRuns", () => {
  it("writes an empty break as a run of the break character", () => {
    expect(breaksToRuns("<a:p><a:r><a:t>a</a:t></a:r><a:br/><a:r><a:t>b</a:t></a:r></a:p>")).toBe(
      `<a:p><a:r><a:t>a</a:t></a:r><a:r><a:t>${LINE_BREAK}</a:t></a:r><a:r><a:t>b</a:t></a:r></a:p>`,
    );
  });

  it("keeps a break's run properties, which size the line it ends", () => {
    expect(breaksToRuns('<a:br><a:rPr lang="ko-KR" sz="1400"/></a:br>')).toBe(
      `<a:r><a:rPr lang="ko-KR" sz="1400"/><a:t>${LINE_BREAK}</a:t></a:r>`,
    );
    expect(breaksToRuns('<a:br xmlns:x="y"><a:rPr><a:latin typeface="A"/></a:rPr></a:br>')).toBe(
      `<a:r><a:rPr><a:latin typeface="A"/></a:rPr><a:t>${LINE_BREAK}</a:t></a:r>`,
    );
  });

  it("leaves other elements alone", () => {
    const xml = "<a:bridge/><a:r><a:t>br</a:t></a:r>";
    expect(breaksToRuns(xml)).toBe(xml);
  });
});

describe("withLineBreaks", () => {
  it("rewrites the slides' breaks and keeps every other part", () => {
    const image = new Uint8Array([1, 2, 3]);
    const bytes = zipSync({
      [SLIDE]: strToU8("<a:p><a:br/></a:p>"),
      "ppt/notesSlides/notesSlide1.xml": strToU8("<a:br/>"),
      "ppt/media/image1.png": image,
      "[Content_Types].xml": strToU8("<Types/>"),
    });
    const files = unzipSync(withLineBreaks(bytes));
    expect(strFromU8(files[SLIDE] as Uint8Array)).toBe(
      `<a:p><a:r><a:t>${LINE_BREAK}</a:t></a:r></a:p>`,
    );
    expect(strFromU8(files["ppt/notesSlides/notesSlide1.xml"] as Uint8Array)).toContain(LINE_BREAK);
    expect(files["ppt/media/image1.png"]).toEqual(image);
    expect(strFromU8(files["[Content_Types].xml"] as Uint8Array)).toBe("<Types/>");
  });

  it("gives back the same bytes when there is no break, or no zip", () => {
    const bytes = zipSync({ [SLIDE]: strToU8("<a:p/>") });
    expect(withLineBreaks(bytes)).toBe(bytes);
    const junk = new Uint8Array([0, 1, 2]);
    expect(withLineBreaks(junk)).toBe(junk);
  });
});
