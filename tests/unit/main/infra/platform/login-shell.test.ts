import { describe, expect, it } from "bun:test";
import os from "node:os";
import { loginShell } from "../../../../../src/main/infra/platform";

describe("loginShell", () => {
  it("takes $SHELL when it is set", () => {
    expect(loginShell({ SHELL: "/usr/local/bin/fish" })).toBe("/usr/local/bin/fish");
  });

  it("falls back to the account's shell when $SHELL is unset or blank", () => {
    const expected =
      os.userInfo().shell || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    expect(loginShell({})).toBe(expected);
    expect(loginShell({ SHELL: "  " })).toBe(expected);
  });
});
