/**
 * Scenario tests for the placement branch used by useSubmenuPlacement.
 *
 * Bun's renderer unit tests do not mount a real DOM, so the hook's React
 * layout effect is covered through the exported resolver that the hook calls
 * after measuring trigger and panel rects.
 */

import { describe, expect, it } from "bun:test";
import {
  ESTIMATED_SUBMENU_HEIGHT_PX,
  resolveSubmenuPlacement,
} from "../../../../../src/renderer/components/ui/use-submenu-placement";

describe("useSubmenuPlacement placement resolver", () => {
  it("keeps the submenu opening downward when the estimated panel fits below the trigger", () => {
    expect(
      resolveSubmenuPlacement({
        triggerTop: 120,
        viewportHeight: 800,
      }),
    ).toBe("down");
  });

  it("flips the submenu upward when the estimated panel would pass the viewport bottom", () => {
    expect(
      resolveSubmenuPlacement({
        triggerTop: 640,
        viewportHeight: 800,
      }),
    ).toBe("up");
  });

  it("uses measured panel height instead of the estimate after render", () => {
    expect(
      resolveSubmenuPlacement({
        triggerTop: 640,
        viewportHeight: 800,
        submenuHeight: ESTIMATED_SUBMENU_HEIGHT_PX - 80,
      }),
    ).toBe("down");
  });
});
