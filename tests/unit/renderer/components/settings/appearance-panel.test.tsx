import { describe, expect, test } from "bun:test";
import { opacityAppliesAfterRestart } from "../../../../../src/renderer/components/settings/panels/appearance-panel";

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
