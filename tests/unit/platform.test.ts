import { describe, it, expect, beforeEach, afterEach } from "bun:test";

// electron is not available in the unit test environment; mock it before
// importing any module that transitively requires it.
import { mock } from "bun:test";

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => `/mock/electron/${name}`,
  },
}));

// Import the function under test after the module mock is in place.
import { getDefaultShell } from "../../src/main/platform/shell";

describe("getDefaultShell", () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalShell: string | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    originalShell = process.env.SHELL;
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, "platform", {
      value: platform,
      writable: true,
      configurable: true,
    });
  }

  it("returns $SHELL on darwin when set", () => {
    setPlatform("darwin");
    process.env.SHELL = "/bin/zsh";
    expect(getDefaultShell()).toBe("/bin/zsh");
  });

  it("falls back to /bin/bash on darwin when $SHELL is absent", () => {
    setPlatform("darwin");
    delete process.env.SHELL;
    expect(getDefaultShell()).toBe("/bin/bash");
  });

  it("throws on win32", () => {
    setPlatform("win32");
    expect(() => getDefaultShell()).toThrow(
      "not implemented in M0"
    );
  });

  it("throws on linux", () => {
    setPlatform("linux");
    expect(() => getDefaultShell()).toThrow(
      "not implemented in M0"
    );
  });
});
