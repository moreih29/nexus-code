import { describe, expect, it } from "bun:test";
import {
  gradientCss,
  isImageData,
  safeColor,
} from "../../../../../../src/renderer/components/editor/preview/slide-dom";
import { isPresentationFile } from "../../../../../../src/renderer/services/editor/preview/pptx";

describe("isPresentationFile", () => {
  it("knows .pptx, .pptm and .ppsx, case aside, and not legacy .ppt", () => {
    expect(isPresentationFile("/w/a/Deck.PPTX")).toBe(true);
    expect(isPresentationFile("/w/a/macros.pptm")).toBe(true);
    expect(isPresentationFile("/w/a/show.ppsx")).toBe(true);
    expect(isPresentationFile("/w/a/old.ppt")).toBe(false);
  });
});

describe("safeColor", () => {
  it("takes CSS colors and nothing else", () => {
    expect(safeColor("#4F81BD")).toBe("#4F81BD");
    expect(safeColor("rgba(0, 0, 0, 0.5)")).toBe("rgba(0, 0, 0, 0.5)");
    expect(safeColor("white")).toBe("white");
    expect(safeColor("")).toBeNull();
    expect(safeColor("red; background: url(x)")).toBeNull();
    expect(safeColor("url(https://e.x)")).toBeNull();
  });
});

describe("gradientCss", () => {
  it("writes a linear gradient turned as the file turns it", () => {
    expect(
      gradientCss({
        path: "line",
        rot: 45,
        colors: [
          { pos: "0%", color: "#000000" },
          { pos: "100000", color: "#ffffff" },
        ],
      }),
    ).toBe("linear-gradient(135deg, #000000 0%, #ffffff 100%)");
  });

  it("writes other paths as radial, and refuses a stop that is not a color", () => {
    expect(gradientCss({ path: "circle", rot: 0, colors: [{ pos: "50", color: "red" }] })).toBe(
      "radial-gradient(red 50%)",
    );
    expect(
      gradientCss({ path: "line", rot: 0, colors: [{ pos: "0", color: "url(x)" }] }),
    ).toBeNull();
  });
});

describe("isImageData", () => {
  it("takes only a picture's base64 data URL", () => {
    expect(isImageData("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isImageData("data:image/svg+xml;base64,PHN2Zz4=")).toBe(true);
    expect(isImageData("https://e.x/a.png")).toBe(false);
    expect(isImageData('data:image/png;base64,AAAA")')).toBe(false);
    expect(isImageData(undefined)).toBe(false);
  });
});
