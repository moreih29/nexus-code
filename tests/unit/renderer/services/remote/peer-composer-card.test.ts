import { describe, expect, test } from "bun:test";

const { answerInCard } = await import("../../../../../src/renderer/services/remote/peer-composer");

describe("what another computer's command said", () => {
  test("goes in a card when it took its time or is long, else in a toast as here", () => {
    expect(answerInCard("Goal paused", false)).toBe(false);
    expect(answerInCard("Yes.", true)).toBe(true);
    expect(answerInCard("a\nb", false)).toBe(true);
    expect(answerInCard("x".repeat(161), false)).toBe(true);
  });
});
