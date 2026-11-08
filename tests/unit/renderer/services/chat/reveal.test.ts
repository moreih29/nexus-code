/**
 * A part of a tab a bare command asks to see: asked, then taken once shown,
 * and a later ask is not taken by an earlier one's showing.
 */

import { describe, expect, test } from "bun:test";
import {
  revealPart,
  takeReveal,
  useChatStore,
} from "../../../../../src/renderer/services/chat/store";

const KEY = "ws-reveal:tab";

describe("revealPart", () => {
  test("asks once per call and is taken when shown", () => {
    revealPart(KEY, "usage");
    const first = useChatStore.getState().tabs[KEY]?.reveal;
    expect(first?.part).toBe("usage");
    revealPart(KEY, "usage");
    const second = useChatStore.getState().tabs[KEY]?.reveal;
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
    // The first ask's showing does not take the second.
    takeReveal(KEY, first?.seq ?? -1);
    expect(useChatStore.getState().tabs[KEY]?.reveal).toEqual(second);
    takeReveal(KEY, second?.seq ?? -1);
    expect(useChatStore.getState().tabs[KEY]?.reveal).toBeUndefined();
    useChatStore.getState().remove(KEY);
  });
});
