/** The token a tab's processes reach the hookserver with. */
import { describe, expect, test } from "bun:test";
import { tabHookToken } from "../../../../../src/main/features/workspace/tab-token";

describe("a tab's hook token", () => {
  test("is the server's bound to the tab, as the agent makes it", () => {
    const info = { socketPath: "/s", token: "secret", tabTokens: true };
    // TestTabTokenIsBoundToTheTab in internal/hookserver/tabtoken_test.go has the same.
    expect(tabHookToken(info, "ws-1", "tab-1")).toBe(
      "ca76041e3856d63c1dc1f0a56162bcd253a7666238f246230a2db56792e956f2",
    );
    expect(tabHookToken(info, "ws-1", "tab-2")).not.toBe(tabHookToken(info, "ws-1", "tab-1"));
    expect(tabHookToken(info, "ws-1|tab", "-1")).not.toBe(tabHookToken(info, "ws-1", "tab-1"));
  });

  test("is the server's own for an agent older than tab tokens", () => {
    expect(tabHookToken({ socketPath: "/s", token: "secret" }, "ws-1", "tab-1")).toBe("secret");
  });
});
