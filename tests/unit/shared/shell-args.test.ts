import { describe, expect, test } from "bun:test";
import {
  joinShellArgs,
  splitShellArgs,
  windowsCommandLineArgs,
} from "../../../src/shared/pty/shell";

describe("windowsCommandLineArgs", () => {
  test("writes each argument as the terminal's Windows command line does", () => {
    const cases: [string, string][] = [
      ["", '""'],
      ["plain", "plain"],
      ["C:\\tools\\nu.exe", "C:\\tools\\nu.exe"],
      ["\\\\server\\share", "\\\\server\\share"],
      ["tail\\", "tail\\"],
      ["~/x", "~/x"],
      ["%PATH%", "%PATH%"],
      ["x y", '"x y"'],
      ["C:\\dir with space\\", '"C:\\dir with space\\\\"'],
      ['a"b', '"a\\"b"'],
      ['"', '"\\""'],
      ['a\\"b', '"a\\\\\\"b"'],
      ['a\\\\"b c', '"a\\\\\\\\\\"b c"'],
      ["it's", '"it\'s"'],
      ["*.txt", '"*.txt"'],
      ["m?.txt", '"m?.txt"'],
      ["[m]1.txt", '"[m]1.txt"'],
      ["{a,b}", '"{a,b}"'],
      ["한글 값", '"한글 값"'],
    ];
    for (const [arg, line] of cases) expect(windowsCommandLineArgs([arg])).toBe(line);
    expect(windowsCommandLineArgs(["-c", 'printf "%s"', "it's"])).toBe(
      '-c "printf \\"%s\\"" "it\'s"',
    );
  });
});

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

  test("keeps an argument whole when a quote starts partway into it", () => {
    expect(splitShellArgs('--init-file="/a b/rc" -i')).toEqual(["--init-file=/a b/rc", "-i"]);
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

test("preserves a quoted PowerShell command when editing a saved shell", () => {
  const args = ["-Command", 'Write-Output "회의 기록"', '""', "C:\\My Config\\", ""];
  const text = joinShellArgs(args);
  expect(text).toContain('"Write-Output ""회의 기록"""');
  expect(splitShellArgs(text)).toEqual(args);
});
