import { describe, expect, test } from "bun:test";
import {
  opacityAppliesAfterRestart,
  opacityHasNoEffect,
} from "../../../../../src/renderer/components/settings/panels/appearance-panel";
import { appliedWindowOpacity } from "../../../../../src/renderer/hooks/use-window-opacity-effect";

describe("opacityAppliesAfterRestart", () => {
  test("is on below 100% in a Linux window that is not transparent", () => {
    expect(opacityAppliesAfterRestart({ platform: "linux" }, 0.6)).toBe(true);
    expect(opacityAppliesAfterRestart({ platform: "linux", transparentWindow: false }, 0.99)).toBe(
      true,
    );
  });

  test("is off at 100% and in a transparent Linux window", () => {
    expect(opacityAppliesAfterRestart({ platform: "linux" }, 1)).toBe(false);
    expect(opacityAppliesAfterRestart({ platform: "linux", transparentWindow: true }, 0.6)).toBe(
      false,
    );
  });

  test("is off where the opacity applies live, and without host info", () => {
    expect(opacityAppliesAfterRestart({ platform: "darwin" }, 0.6)).toBe(false);
    expect(opacityAppliesAfterRestart({ platform: "win32" }, 0.6)).toBe(false);
    expect(opacityAppliesAfterRestart(undefined, 0.6)).toBe(false);
  });
});

describe("opacityHasNoEffect", () => {
  test("is on in an opaque Windows window only", () => {
    expect(opacityHasNoEffect({ platform: "win32", opaqueWindow: true })).toBe(true);
    expect(opacityHasNoEffect({ platform: "win32" })).toBe(false);
    expect(opacityHasNoEffect({ platform: "darwin" })).toBe(false);
    expect(opacityHasNoEffect(undefined)).toBe(false);
  });
});

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
