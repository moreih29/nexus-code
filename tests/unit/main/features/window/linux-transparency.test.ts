import { describe, expect, test } from "bun:test";
import { opensTransparentOnLinux } from "../../../../../src/main/features/window/linux-transparency";

describe("opensTransparentOnLinux", () => {
  test("opens transparent on Linux while the saved opacity is under 100%", () => {
    expect(opensTransparentOnLinux(0.6, "linux")).toBe(true);
    expect(opensTransparentOnLinux(0.99, "linux")).toBe(true);
    expect(opensTransparentOnLinux(0, "linux")).toBe(true);
  });

  test("keeps the frame on Linux at 100% or with nothing saved", () => {
    expect(opensTransparentOnLinux(1, "linux")).toBe(false);
    expect(opensTransparentOnLinux(undefined, "linux")).toBe(false);
  });

  test("is off on other platforms", () => {
    expect(opensTransparentOnLinux(0.6, "darwin")).toBe(false);
    expect(opensTransparentOnLinux(0.6, "win32")).toBe(false);
  });
});
