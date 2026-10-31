/**
 * windows-shell-shim.test.ts — how each Windows shell gets a `claude` that
 * runs with the app's hooks, and the hooks file taken from the wrapper.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  applyWindowsShellShim,
  wrapperHooksSettings,
} from "../../../../src/main/features/pty/windows-shell-shim";

const SETTINGS = "C:\\Users\\me\\.nexus-code\\claude-settings.json";
const BIN = "C:\\Users\\me\\.nexus-code\\bin";
const ENV = { NEXUS_IN_APP: "1", NEXUS_WRAPPER_SELF_DIR: BIN, NEXUS_TAB_ID: "t" };

const decode = (args: string[] | undefined) =>
  Buffer.from(args?.at(-1) ?? "", "base64").toString("utf16le");

describe("wrapperHooksSettings", () => {
  test("reads the hooks the wrapper writes", () => {
    const wrapper = fs.readFileSync(
      path.join(import.meta.dir, "../../../../scripts/assets/claude-wrapper.sh"),
      "utf8",
    );
    const settings = JSON.parse(wrapperHooksSettings(wrapper) ?? "null");
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "Notification",
      "Stop",
      "SessionEnd",
      "PermissionRequest",
    ]);
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/^"\$\{NEXUS_AGENT_BIN\}" hook stop$/);
  });

  test("null for text without them", () => {
    expect(wrapperHooksSettings("#!/bin/bash\nexec claude\n")).toBeNull();
    expect(wrapperHooksSettings("<<'SETTINGS_EOF'\n{ not json\nSETTINGS_EOF\n")).toBeNull();
  });
});

describe("applyWindowsShellShim", () => {
  test("PowerShell defines a claude function as it starts", () => {
    for (const shell of [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ]) {
      const { env, args } = applyWindowsShellShim({ shell, env: ENV, settingsPath: SETTINGS });
      expect(args?.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"]);
      expect(decode(args)).toStartWith("function global:claude {");
      expect(env.NEXUS_CLAUDE_SETTINGS).toBe(SETTINGS);
      expect(env.NEXUS_WRAPPER_SELF_DIR).toBeUndefined();
      expect(env.NEXUS_IN_APP).toBe("1");
    }
  });

  test("PowerShell keeps its own switches, and a command of its own", () => {
    const shell = "pwsh.exe";
    const withSwitch = applyWindowsShellShim({
      shell,
      env: ENV,
      args: ["-NoLogo"],
      settingsPath: SETTINGS,
    });
    expect(withSwitch.args?.slice(0, 3)).toEqual(["-NoLogo", "-NoExit", "-EncodedCommand"]);
    for (const args of [
      ["-Command", "Get-Date"],
      ["-c", "x"],
      ["-ec", "AA=="],
      ["-File", "a.ps1"],
      ["a.ps1"],
    ]) {
      expect(applyWindowsShellShim({ shell, env: ENV, args, settingsPath: SETTINGS })).toEqual({
        env: { NEXUS_IN_APP: "1", NEXUS_TAB_ID: "t" },
        args,
      });
    }
  });

  test("cmd defines a doskey macro through a variable", () => {
    const { env, args } = applyWindowsShellShim({
      shell: "C:\\Windows\\system32\\cmd.exe",
      env: ENV,
      settingsPath: SETTINGS,
    });
    expect(args).toEqual(["/k", "%NEXUS_CMD_INIT%"]);
    expect(env.NEXUS_CMD_INIT).toBe(`doskey claude=claude --settings "${SETTINGS}" $*`);
    expect(env.NEXUS_WRAPPER_SELF_DIR).toBeUndefined();
    const own = applyWindowsShellShim({
      shell: "cmd.exe",
      env: ENV,
      args: ["/K", "init.cmd"],
      settingsPath: SETTINGS,
    });
    expect(own.args).toEqual(["/K", "init.cmd"]);
    expect(own.env.NEXUS_CMD_INIT).toBeUndefined();
  });

  test("Git Bash keeps the wrapper first on PATH; WSL's bash doesn't", () => {
    const gitBash = applyWindowsShellShim({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      env: ENV,
      args: ["--login", "-i"],
      settingsPath: SETTINGS,
    });
    expect(gitBash).toEqual({ env: ENV, args: ["--login", "-i"] });
    // Started from Git Bash, the app passes on an ORIGINAL_PATH, which Git
    // Bash's profile builds PATH from.
    const fromGitBash = applyWindowsShellShim({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      env: ENV,
      settingsPath: SETTINGS,
      originalPath: "C:\\Windows\\system32",
    });
    expect(fromGitBash.env.ORIGINAL_PATH).toBe(`${BIN};C:\\Windows\\system32`);
    const wsl = applyWindowsShellShim({
      shell: "C:\\Windows\\System32\\bash.exe",
      env: ENV,
      settingsPath: SETTINGS,
    });
    expect(wsl.env.NEXUS_WRAPPER_SELF_DIR).toBeUndefined();
  });

  test("without the hooks file, no shell gets the wrapper or hooks", () => {
    for (const shell of ["powershell.exe", "cmd.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
      expect(applyWindowsShellShim({ shell, env: ENV })).toEqual({
        env: { NEXUS_IN_APP: "1", NEXUS_TAB_ID: "t" },
        args: undefined,
      });
    }
  });
});
