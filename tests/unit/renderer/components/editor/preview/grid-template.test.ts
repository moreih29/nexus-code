import { describe, expect, it } from "bun:test";
import {
  FIELD_CHROME_PX,
  FIELD_PADDING_PX,
  fieldTrack,
  gridTemplate,
  gutterTrack,
} from "../../../../../../src/renderer/components/editor/preview/grid-template";

describe("fieldTrack", () => {
  it("adds the cell's padding and its border to the content width", () => {
    expect(FIELD_CHROME_PX).toBe(FIELD_PADDING_PX + 1);
    expect(fieldTrack(15)).toBe("calc(15ch + 17px)");
  });
});

describe("gutterTrack", () => {
  it("fits the row numbers and the cell's padding", () => {
    expect(gutterTrack(5)).toBe("calc(2ch + 8px)");
    expect(gutterTrack(1000)).toBe("calc(4ch + 8px)");
  });
});

describe("gridTemplate", () => {
  it("is the row numbers' track, then one track per column", () => {
    expect(gridTemplate(220, [4, 15])).toBe("calc(3ch + 8px) calc(4ch + 17px) calc(15ch + 17px)");
  });
});
