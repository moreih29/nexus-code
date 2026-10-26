import { describe, expect, test } from "bun:test";
import { isImeComposing } from "../../../../src/renderer/utils/ime";

describe("isImeComposing", () => {
  test("reads isComposing from a native keyboard event", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 } as KeyboardEvent)).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 } as KeyboardEvent)).toBe(false);
  });

  test("treats keyCode 229 as composing when isComposing is late", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 } as KeyboardEvent)).toBe(true);
  });

  test("unwraps a React synthetic event", () => {
    const synthetic = { nativeEvent: { isComposing: true, keyCode: 13 } } as React.KeyboardEvent;
    expect(isImeComposing(synthetic)).toBe(true);
  });
});
