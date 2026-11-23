import { expect, test } from "bun:test";
import { startsOnCancel } from "../../../../src/renderer/components/ui/confirm-dialog";

test("a confirmation starts on Confirm, a destructive one on Cancel, as before", () => {
  expect(startsOnCancel({})).toBe(false);
  expect(startsOnCancel({ variant: "default" })).toBe(false);
  expect(startsOnCancel({ variant: "destructive" })).toBe(true);
});

test("a confirmation can ask to start on Cancel without looking destructive", () => {
  expect(startsOnCancel({ focus: "cancel" })).toBe(true);
  expect(startsOnCancel({ variant: "destructive", focus: "confirm" })).toBe(false);
});
