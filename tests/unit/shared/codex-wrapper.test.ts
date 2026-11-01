/**
 * The codex wrapper: which codex it runs, and when it adds --no-daemon. Each
 * test puts a fake codex on PATH that prints its arguments, and whose help
 * has the option or not, as a newer or an older codex.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyWindowsShellShim } from "../../../src/main/features/pty/windows-shell-shim";
import { CODEX_WRAPPER } from "../../../src/shared/codex/wrapper";

const GIT_BASH = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Git",
  "bin",
  "bash.exe",
);
const describeOnPosix = describe.skipIf(process.platform === "win32");
const describeInGitBash = describe.skipIf(process.platform !== "win32" || !fs.existsSync(GIT_BASH));
const describeOnWindows = describe.skipIf(process.platform !== "win32");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-codex-wrapper-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, text: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  return file;
}

/** A codex that prints its arguments a line each; FAKE_OLD makes it one without --no-daemon. */
const FAKE_CODEX = `#!/bin/sh
if [ "$1" = --help ]; then
  echo "Usage: codex [OPTIONS] [PROMPT]"
  [ -n "\${FAKE_OLD:-}" ] || echo "      --no-daemon"
  exit 0
fi
echo "real codex"
for arg in "$@"; do echo "arg: $arg"; done
`;

/** The wrapper's directory and the real codex's, as they stand on PATH. */
function install(): { wrapperDir: string; realDir: string } {
  const wrapperDir = path.join(tmp, "wrapper");
  const realDir = path.join(tmp, "real");
  write(path.join(wrapperDir, "codex"), CODEX_WRAPPER);
  write(path.join(realDir, "codex"), FAKE_CODEX);
  return { wrapperDir, realDir };
}

function argsOf(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("arg: "))
    .map((line) => line.slice("arg: ".length));
}

describeOnPosix("codex wrapper", () => {
  function run(args: string[], env: Record<string, string> = {}, dirs = install()) {
    const result = spawnSync(path.join(dirs.wrapperDir, "codex"), args, {
      env: {
        PATH: `${dirs.wrapperDir}:${dirs.realDir}:/usr/bin:/bin`,
        NEXUS_IN_APP: "1",
        NEXUS_WRAPPER_SELF_DIR: dirs.wrapperDir,
        ...env,
      },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  test("starts codex with --no-daemon in the app, the arguments as they were", () => {
    const result = run(["fix the 'tests'", "$HOME", "*"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toStartWith("real codex\n");
    expect(argsOf(result.stdout)).toEqual(["--no-daemon", "fix the 'tests'", "$HOME", "*"]);
  });

  test("adds it for resume and fork, which start the interactive codex", () => {
    expect(argsOf(run(["resume", "--last"]).stdout)).toEqual(["--no-daemon", "resume", "--last"]);
    expect(argsOf(run(["-m", "o3", "fork"]).stdout)).toEqual(["--no-daemon", "-m", "o3", "fork"]);
  });

  test("leaves it off where codex refuses it or has it already", () => {
    for (const args of [
      ["agents"],
      ["queue", "--thread", "t", "--message", "m"],
      ["-c", "x=1", "agents"],
      ["--remote", "ws://127.0.0.1:1"],
      ["--remote=ws://127.0.0.1:1"],
      ["app-server", "daemon", "stop"],
      ["remote-control"],
      ["--no-daemon", "resume"],
    ]) {
      expect(argsOf(run(args).stdout)).toEqual(args);
    }
  });

  test("leaves it off for a codex without it", () => {
    expect(argsOf(run(["hi"], { FAKE_OLD: "1" }).stdout)).toEqual(["hi"]);
  });

  test("leaves it off outside the app", () => {
    expect(argsOf(run(["hi"], { NEXUS_IN_APP: "" }).stdout)).toEqual(["hi"]);
  });

  test("skips another copy of itself on PATH", () => {
    const dirs = install();
    const copy = path.join(tmp, "copy");
    write(path.join(copy, "codex"), CODEX_WRAPPER);
    const result = spawnSync(path.join(dirs.wrapperDir, "codex"), ["hi"], {
      env: {
        PATH: `${dirs.wrapperDir}:${copy}:${dirs.realDir}:/usr/bin:/bin`,
        NEXUS_IN_APP: "1",
        NEXUS_WRAPPER_SELF_DIR: dirs.wrapperDir,
      },
      encoding: "utf8",
    });
    expect(argsOf(result.stdout)).toEqual(["--no-daemon", "hi"]);
  });

  test("finds its own directory without NEXUS_WRAPPER_SELF_DIR", () => {
    expect(argsOf(run(["hi"], { NEXUS_WRAPPER_SELF_DIR: "" }).stdout)).toEqual([
      "--no-daemon",
      "hi",
    ]);
  });

  test("says so when there is no codex", () => {
    const dirs = install();
    fs.rmSync(path.join(dirs.realDir, "codex"));
    const result = run(["hi"], {}, dirs);
    expect(result.status).toBe(127);
    expect(result.stderr).toBe("codex: command not found\n");
  });
});

describeInGitBash("codex wrapper — Git Bash on Windows", () => {
  test("starts codex with --no-daemon", () => {
    const { wrapperDir, realDir } = install();
    const result = spawnSync(GIT_BASH, [path.join(wrapperDir, "codex"), "hi"], {
      env: {
        ...process.env,
        NEXUS_IN_APP: "1",
        NEXUS_WRAPPER_SELF_DIR: wrapperDir,
        PATH: `${wrapperDir};${realDir};${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(argsOf(result.stdout.replaceAll("\r", ""))).toEqual(["--no-daemon", "hi"]);
  });
});

describeOnWindows("PowerShell's codex function", () => {
  /** Runs `calls` after the function in Windows PowerShell, with a fake codex.cmd on PATH. */
  function runPowerShell(calls: string, env: Record<string, string> = {}): string {
    const realDir = path.join(tmp, "real");
    write(
      path.join(realDir, "codex.cmd"),
      [
        "@echo off",
        'if "%~1"=="--help" (',
        "  echo Usage: codex [OPTIONS] [PROMPT]",
        "  if not defined FAKE_OLD echo       --no-daemon",
        "  exit /b 0",
        ")",
        "echo ARGS:%*",
        "",
      ].join("\r\n"),
    );
    const shim = applyWindowsShellShim({
      shell: "powershell.exe",
      env: {},
      codex: { cmd: false },
    });
    const functions = Buffer.from(shim.args?.at(-1) ?? "", "base64").toString("utf16le");
    const script = Buffer.from(`${functions}\n${calls}`, "utf16le").toString("base64");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", script],
      {
        env: { ...process.env, ...env, PATH: `${realDir};${process.env.PATH ?? ""}` },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    return result.stdout.replaceAll("\r", "");
  }

  test("adds --no-daemon unless codex refuses it or lacks it", () => {
    expect(runPowerShell("codex 'a b'; codex agents; codex --remote=ws://x; codex resume")).toBe(
      'ARGS:--no-daemon "a b"\nARGS:agents\nARGS:--remote=ws://x\nARGS:--no-daemon resume\n',
    );
    expect(runPowerShell("codex hi", { FAKE_OLD: "1" })).toBe("ARGS:hi\n");
  });
});
