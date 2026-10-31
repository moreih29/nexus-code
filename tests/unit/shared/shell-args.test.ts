import { describe, expect, test } from "bun:test";
import { joinShellArgs, splitShellArgs } from "../../../src/shared/pty/shell";

describe("splitShellArgs", () => {
  test("splits on whitespace", () => {
    expect(splitShellArgs("  -NoLogo   -ExecutionPolicy Bypass ")).toEqual([
      "-NoLogo",
      "-ExecutionPolicy",
      "Bypass",
    ]);
  });

  test("keeps a double-quoted argument whole", () => {
    expect(splitShellArgs('--config "C:\\My Config\\nu.nu" -l')).toEqual([
      "--config",
      "C:\\My Config\\nu.nu",
      "-l",
    ]);
  });

  test("an empty field has no arguments", () => {
    expect(splitShellArgs("   ")).toEqual([]);
  });
});

describe("joinShellArgs", () => {
  test("round-trips through splitShellArgs", () => {
    const args = ["--config", "C:\\My Config\\nu.nu", "-l", ""];
    expect(joinShellArgs(args)).toBe('--config "C:\\My Config\\nu.nu" -l ""');
    expect(splitShellArgs(joinShellArgs(args))).toEqual(args);
  });
});
