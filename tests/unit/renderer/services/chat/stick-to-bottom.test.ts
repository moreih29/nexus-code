/**
 * A chat list stays at its bottom as it grows until the user scrolls up. The
 * scroll event of the code's own scroll to the bottom comes a frame late,
 * when more may have come in; it must not read as the user scrolling up.
 */
import { describe, expect, it } from "bun:test";
import {
  isOwnScroll,
  nearBottom,
  STICK_SLACK_PX,
} from "../../../../../src/renderer/services/chat/stick-to-bottom";

describe("nearBottom", () => {
  it("counts a list within the slack of its bottom as there", () => {
    expect(nearBottom({ scrollTop: 760, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
    expect(
      nearBottom({ scrollTop: 800 - STICK_SLACK_PX - 1, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(false);
  });
});

describe("isOwnScroll", () => {
  it("takes the event at the position the code set as the code's, however much came in since", () => {
    // Taken down to 25 with 239 px of content; the transcript then grew it to 953.
    const view = { scrollTop: 25, scrollHeight: 953, clientHeight: 214 };
    expect(isOwnScroll(view, 25)).toBe(true);
    expect(nearBottom(view)).toBe(false);
  });

  it("allows a pixel of rounding", () => {
    expect(isOwnScroll({ scrollTop: 25.5, scrollHeight: 953, clientHeight: 214 }, 25)).toBe(true);
  });

  it("takes any other position as the user's", () => {
    expect(isOwnScroll({ scrollTop: 10, scrollHeight: 953, clientHeight: 214 }, 25)).toBe(false);
    expect(isOwnScroll({ scrollTop: 25, scrollHeight: 953, clientHeight: 214 }, null)).toBe(false);
  });
});
