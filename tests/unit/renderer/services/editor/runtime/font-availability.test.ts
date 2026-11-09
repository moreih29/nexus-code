/**
 * A font name typed whole is taken when the browser draws a font for it, but
 * not when that font is Times: Chrome on macOS draws Times for Apple SD
 * Gothic Neo's Korean name. The widths are those Chrome measured on macOS.
 */
import { describe, expect, it } from "bun:test";
import {
  drawnAlike,
  type ProbeWidths,
} from "../../../../../../src/renderer/services/editor/runtime/font-availability";

const TIMES: ProbeWidths = [1048.01, 1048.01];

describe("drawnAlike", () => {
  it("tells Times drawn in place of a name", () => {
    const korean: ProbeWidths = [1048.01, 1048.01]; // "Apple SD 산돌고딕 Neo"
    expect(drawnAlike(korean, TIMES)).toBe(true);
  });

  it("tells another font from Times", () => {
    expect(drawnAlike([1143.18, 1143.18], TIMES)).toBe(false); // Georgia
    // A name not drawn at all: each fallback's own width.
    expect(drawnAlike([1040.34, 1046.88], TIMES)).toBe(false);
  });

  it("allows half a pixel of measuring noise", () => {
    expect(drawnAlike([1048.4, 1047.7], TIMES)).toBe(true);
    expect(drawnAlike([1048.01, 1048.6], TIMES)).toBe(false);
  });
});
