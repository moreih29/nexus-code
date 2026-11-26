import { describe, expect, jest, test } from "bun:test";
import {
  canRestoreFailedDraft,
  composerSendDecision,
  waitForPeerSend,
} from "../../../../../src/renderer/services/chat/composer-submit";

test.each([
  [true, true, true, "send"],
  [false, true, true, "wait"],
  [false, false, true, "offline"],
  [true, true, false, "changed"],
  [false, true, false, "changed"],
] as const)("send decision for ready=%s shown=%s sameDraft=%s", (ready, shown, sameDraft, expected) => {
  expect(composerSendDecision(ready, shown, sameDraft)).toBe(expected);
});

describe("a remote send waiting for chat readiness", () => {
  test.each(["send", "changed", "offline", null] as const)("settles as %p", async (expected) => {
    jest.useFakeTimers();
    try {
      let ready = false;
      const pressed = { text: "draft" };
      let draft = pressed;
      const waiting = waitForPeerSend(
        Date.now() + 3_000,
        () => ready,
        () => draft === pressed,
      );
      const settled = jest.fn();
      void waiting.result.then(settled);
      jest.advanceTimersByTime(2_999);
      waiting.check();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      if (expected === "offline") jest.advanceTimersByTime(1);
      else if (expected === null) waiting.cancel();
      else {
        ready = expected === "send";
        if (expected === "changed") draft = { text: "edited" };
        waiting.check();
      }
      expect(await waiting.result).toBe(expected);
      expect(draft.text).toBe(expected === "changed" ? "edited" : "draft");
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

const empty = { text: "", images: [], files: [], notes: [] };

test.each([
  ["empty", empty, "failed", true],
  ["whitespace", { ...empty, text: " " }, "failed", false],
  ["new text", { ...empty, text: "next" }, "failed", false],
  ["image", { ...empty, images: [{}] }, "failed", false],
  ["file", { ...empty, files: [{}] }, "failed", false],
  ["note", { ...empty, notes: [{}] }, "failed", false],
  ["uncertain delivery", empty, "unconfirmed", false],
] as const)("automatic draft recovery with %s", (_name, draft, status, expected) => {
  expect(canRestoreFailedDraft(draft, status)).toBe(expected);
});
