import { expect, test } from "bun:test";
import {
  canRestoreFailedDraft,
  composerSendDecision,
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
