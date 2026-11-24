import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { claudeSettingsEnv } from "../../../../src/main/features/pty/claude-settings-env";
import {
  applyWindowsShellShim,
  serverlessHooksSettings,
  wrapperHooksSettings,
} from "../../../../src/main/features/pty/windows-shell-shim";
import { CODEX_CMD_HELP, CODEX_CMD_LAUNCHER } from "../../../../src/shared/codex/wrapper";

const SETTINGS = "C:\\Users\\me\\.nexus-code\\claude-settings.json";
const SERVERLESS = "C:\\Users\\me\\.nexus-code\\claude-settings-serverless.json";
const CMD_CLAUDE =
  `doskey claude=set "NEXUS_CLAUDE_TAB_ID=%NEXUS_TAB_ID%" ^& ` +
  `claude --settings "%NEXUS_CLAUDE_SETTINGS%" $* ^& set "NEXUS_CLAUDE_TAB_ID="`;
const BIN = "C:\\Users\\me\\.nexus-code\\bin";
const CMD_BIN = `${BIN}\\cmd`;
const LAUNCHERS = "C:\\Users\\me\\.nexus-code\\cli";
const ENV = { NEXUS_IN_APP: "1", NEXUS_WRAPPER_SELF_DIR: LAUNCHERS, NEXUS_TAB_ID: "t" };

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
      "PostToolUse",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
      "Notification",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "PermissionRequest",
      "WorktreeCreate",
      "WorktreeRemove",
    ]);
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/^"\$\{NEXUS_AGENT_BIN\}" hook stop$/);
  });

  test("without the hook server only the SendMessage guard stays", () => {
    const wrapper = fs.readFileSync(
      path.join(import.meta.dir, "../../../../scripts/assets/claude-wrapper.sh"),
      "utf8",
    );
    const full = JSON.parse(wrapperHooksSettings(wrapper) ?? "null");
    const serverless = JSON.parse(serverlessHooksSettings(JSON.stringify(full)));
    expect(serverless.preferredNotifChannel).toBe(full.preferredNotifChannel);
    const guard = full.hooks.PreToolUse.find(
      (group: { matcher: string }) => group.matcher === "SendMessage",
    );
    expect(serverless.hooks).toEqual({ PreToolUse: [guard] });
    expect(guard.hooks).toHaveLength(1);
    expect(guard.hooks[0].command).toMatch(/^"\$\{NEXUS_AGENT_BIN\}" hook send-message$/);
    expect(JSON.stringify(serverless)).not.toMatch(/ cli |permission-request|agent-context/);
  });

  test("null for text without them", () => {
    expect(wrapperHooksSettings("#!/bin/bash\nexec claude\n")).toBeNull();
    expect(wrapperHooksSettings("<<'SETTINGS_EOF'\n{ not json\nSETTINGS_EOF\n")).toBeNull();
  });
});

describe("applyWindowsShellShim", () => {
  test("the two Windows shells use the same bounded Codex help probe", () => {
    const script = decode(applyWindowsShellShim({ shell: "pwsh.exe", env: ENV, codex: {} }).args);
    const probe = CODEX_CMD_HELP.slice(0, CODEX_CMD_HELP.indexOf("\nif (Test-NexusCodexNoDaemon"));
    expect(probe).toContain("3000");
    expect(probe).toContain(".WaitForExit(");
    expect(script).toContain(probe);
    expect(CODEX_CMD_LAUNCHER).toContain("if errorlevel 1 goto :plain");
  });

  test("PowerShell defines a claude function as it starts", () => {
    for (const shell of [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    ]) {
      const { env, args } = applyWindowsShellShim({
        shell,
        env: ENV,
        settingsPath: SETTINGS,
        wrapperDir: BIN,
      });
      expect(args?.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"]);
      expect(decode(args)).toStartWith("function global:claude {");
      expect(decode(args)).toContain("$env:NEXUS_CLAUDE_TAB_ID = $env:NEXUS_TAB_ID");
      expect(decode(args)).toContain("$env:NEXUS_CLAUDE_PRINT = if ($args | Where-Object");
      expect(decode(args)).toContain("$env:NEXUS_CLAUDE_TAB_ID, $env:NEXUS_CLAUDE_PRINT = $marks");
      expect(env.NEXUS_CLAUDE_SETTINGS).toBe(SETTINGS);
      expect(env.NEXUS_WRAPPER_SELF_DIR).toBe(LAUNCHERS);
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
        env: ENV,
        args,
      });
    }
  });

  test("cmd defines a doskey macro through a variable", () => {
    const { env, args } = applyWindowsShellShim({
      shell: "C:\\Windows\\system32\\cmd.exe",
      env: ENV,
      settingsPath: SETTINGS,
      wrapperDir: BIN,
    });
    expect(args).toEqual(["/k", "%NEXUS_CMD_INIT%"]);
    expect(env.NEXUS_CMD_INIT).toBe(CMD_CLAUDE);
    expect(env.NEXUS_CLAUDE_SETTINGS).toBe(SETTINGS);
    expect(env.NEXUS_WRAPPER_SELF_DIR).toBe(LAUNCHERS);
    const own = applyWindowsShellShim({
      shell: "cmd.exe",
      env: ENV,
      args: ["/K", "init.cmd"],
      settingsPath: SETTINGS,
    });
    expect(own.args).toEqual(["/K", "init.cmd"]);
    expect(own.env.NEXUS_CMD_INIT).toBeUndefined();
  });

  test("Git Bash has the wrapper first on PATH; WSL's bash neither directory", () => {
    const gitBash = applyWindowsShellShim({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      env: ENV,
      args: ["--login", "-i"],
      settingsPath: SETTINGS,
      wrapperDir: BIN,
    });
    expect(gitBash).toEqual({
      env: { ...ENV, NEXUS_WRAPPER_SELF_DIR: BIN },
      args: ["--login", "-i"],
    });
    const fromGitBash = applyWindowsShellShim({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      env: ENV,
      settingsPath: SETTINGS,
      wrapperDir: BIN,
      originalPath: "C:\\Windows\\system32",
    });
    expect(fromGitBash.env.ORIGINAL_PATH).toBe(`${BIN};C:\\Windows\\system32`);
    const wsl = applyWindowsShellShim({
      shell: "C:\\Windows\\System32\\bash.exe",
      env: ENV,
      settingsPath: SETTINGS,
      wrapperDir: BIN,
      originalPath: "C:\\Windows\\system32",
    });
    expect(wsl.env.NEXUS_WRAPPER_SELF_DIR).toBeUndefined();
    expect(wsl.env.ORIGINAL_PATH).toBeUndefined();
  });

  test("a Git Bash started from PowerShell or cmd keeps the launchers first on PATH", () => {
    for (const shell of ["powershell.exe", "cmd.exe"]) {
      for (const settingsPath of [SETTINGS, undefined]) {
        const { env } = applyWindowsShellShim({
          shell,
          env: ENV,
          settingsPath,
          wrapperDir: BIN,
          originalPath: "C:\\Windows\\system32",
        });
        expect(env.ORIGINAL_PATH).toBe(`${LAUNCHERS};C:\\Windows\\system32`);
      }
    }
    const own = applyWindowsShellShim({
      shell: "powershell.exe",
      env: ENV,
      args: ["-Command", "claude"],
      settingsPath: SETTINGS,
      originalPath: "C:\\Windows\\system32",
    });
    expect(own.env.ORIGINAL_PATH).toBe(`${LAUNCHERS};C:\\Windows\\system32`);
  });

  test("PowerShell defines codex next to claude, or alone without the hooks", () => {
    const both = applyWindowsShellShim({
      shell: "pwsh.exe",
      env: ENV,
      settingsPath: SETTINGS,
      codex: {},
    });
    expect(decode(both.args)).toMatch(
      /^function global:claude \{[\s\S]*\nfunction global:codex \{/,
    );
    const alone = applyWindowsShellShim({ shell: "pwsh.exe", env: ENV, codex: {} });
    expect(alone.args?.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"]);
    expect(decode(alone.args)).toStartWith("function global:codex {");
    expect(decode(alone.args)).toContain(
      "@('agents', 'queue', 'app-server', 'remote-control', '--remote', '--no-daemon')",
    );
    expect(alone.env).toEqual(ENV);
  });

  test("cmd puts the Codex launcher on PATH and keeps the Claude macro", () => {
    const both = applyWindowsShellShim({
      shell: "cmd.exe",
      env: ENV,
      settingsPath: SETTINGS,
      codex: { cmdLauncherDir: CMD_BIN },
    });
    expect(both.env.NEXUS_CMD_INIT).toBe(CMD_CLAUDE);
    expect(both.env.NEXUS_CMD_CODEX_DIR).toBe(CMD_BIN);
    expect(both.env.NEXUS_WRAPPER_SELF_DIR).toBe(LAUNCHERS);
    const alone = applyWindowsShellShim({
      shell: "cmd.exe",
      env: ENV,
      codex: { cmdLauncherDir: CMD_BIN },
    });
    expect(alone.env.NEXUS_CMD_INIT).toBeUndefined();
    expect(alone.env.NEXUS_CMD_CODEX_DIR).toBe(CMD_BIN);
    expect(alone.args).toBeUndefined();
    expect(applyWindowsShellShim({ shell: "cmd.exe", env: ENV, codex: {} })).toEqual({
      env: ENV,
      args: undefined,
    });
  });

  test("Git Bash has the wrappers first on PATH without the hooks too", () => {
    const gitBash = applyWindowsShellShim({
      shell: "C:\\Program Files\\Git\\bin\\bash.exe",
      env: ENV,
      wrapperDir: BIN,
      codex: {},
    });
    expect(gitBash.env.NEXUS_WRAPPER_SELF_DIR).toBe(BIN);
  });

  test("without the hooks file, no shell gets the wrapper or hooks, only the launchers", () => {
    for (const shell of ["powershell.exe", "cmd.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]) {
      expect(applyWindowsShellShim({ shell, env: ENV })).toEqual({ env: ENV, args: undefined });
    }
  });

  test("PowerShell and cmd carry the serverless hooks file for a terminal without the server", () => {
    for (const shell of ["pwsh.exe", "cmd.exe"]) {
      const { env } = applyWindowsShellShim({
        shell,
        env: ENV,
        settingsPath: SETTINGS,
        serverlessSettingsPath: SERVERLESS,
      });
      expect(env.NEXUS_CLAUDE_SETTINGS).toBe(SETTINGS);
      expect(env.NEXUS_CLAUDE_SERVERLESS_SETTINGS).toBe(SERVERLESS);
      expect(claudeSettingsEnv(env, true)).toEqual({
        ...ENV,
        ...(shell === "cmd.exe" ? { NEXUS_CMD_INIT: CMD_CLAUDE } : {}),
        NEXUS_CLAUDE_SETTINGS: SETTINGS,
      });
      expect(claudeSettingsEnv(env, false)).toEqual({
        ...ENV,
        ...(shell === "cmd.exe" ? { NEXUS_CMD_INIT: CMD_CLAUDE } : {}),
        NEXUS_CLAUDE_SETTINGS: SERVERLESS,
      });
    }
    expect(claudeSettingsEnv(ENV, false)).toBe(ENV);
  });
});
