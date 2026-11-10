import { describe, expect, it } from "bun:test";
import { formatTokens } from "../../../../../src/renderer/services/chat/usage-line";

describe("a token count, as the chat shows it", () => {
  it("is the count itself below a thousand", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(942)).toBe("942");
  });

  it("keeps its tenth in thousands, a round one too", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2000)).toBe("2.0k");
    expect(formatTokens(24_460)).toBe("24.5k");
    expect(formatTokens(400_000)).toBe("400.0k");
  });

  it("goes to millions once the thousands round to a thousand", () => {
    expect(formatTokens(999_940)).toBe("999.9k");
    expect(formatTokens(999_960)).toBe("1.0M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});
