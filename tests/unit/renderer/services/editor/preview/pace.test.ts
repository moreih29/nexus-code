import { describe, expect, test } from "bun:test";
import { previewUpdateDelay } from "../../../../../../src/renderer/services/editor/preview/pace";

describe("a live preview's pace", () => {
  test("a light preview follows the next frame", () => {
    expect(previewUpdateDelay(1000, 3, 1004)).toBe(0);
    expect(previewUpdateDelay(1000, 5, 1001)).toBe(0);
  });

  test("a heavy one leaves twice its render time free after it rendered", () => {
    expect(previewUpdateDelay(1000, 200, 1210)).toBe(390);
  });

  test("text that changes after a pause long enough shows at once", () => {
    expect(previewUpdateDelay(1000, 200, 1700)).toBe(0);
  });

  test("however heavy, it waits at most a second", () => {
    expect(previewUpdateDelay(1000, 5000, 1000)).toBe(1000);
  });
});
