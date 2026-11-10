import { describe, expect, test } from "bun:test";
import { appliedWindowOpacity } from "../../../../../src/renderer/hooks/use-window-opacity-effect";

describe("appliedWindowOpacity", () => {
  test("applies the preference where the window shows through", () => {
    expect(appliedWindowOpacity(0.4, { platform: "win32" })).toBe(0.4);
    expect(appliedWindowOpacity(0.4, { platform: "darwin" })).toBe(0.4);
    expect(appliedWindowOpacity(0.4, undefined)).toBe(0.4);
  });

  test("stays opaque in an opaque window", () => {
    expect(appliedWindowOpacity(0.4, { platform: "win32", opaqueWindow: true })).toBe(1);
  });
});
