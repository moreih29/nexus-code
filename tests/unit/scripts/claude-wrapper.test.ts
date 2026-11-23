import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const WRAPPER_PATH = path.resolve(import.meta.dir, "../../../scripts/assets/claude-wrapper.sh");

const describeOnPosix = describe.skipIf(process.platform === "win32");
const GIT_BASH = path.join(
  process.env.ProgramFiles ?? "C:\\Program Files",
  "Git",
  "bin",
  "bash.exe",
);
const describeInGitBash = describe.skipIf(process.platform !== "win32" || !fs.existsSync(GIT_BASH));
const HOOK_EVENT_NAMES = [
  "session-start",
  "user-prompt-submit",
  "pre-tool-use",
  "post-tool-use",
  "post-tool-use-failure",
  "subagent-start",
  "subagent-stop",
  "notification",
  "stop",
  "stop-failure",
  "session-end",
  "permission-request",
] as const;

describeOnPosix("Claude binary selection", () => {
  test("the wrapper executes the probed binary even when PATH starts with a different one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-probed-claude-"));
    try {
      const onPath = path.join(dir, "claude");
      const probed = path.join(dir, "probed claude");
      fs.writeFileSync(onPath, "#!/bin/sh\necho wrong\n", { mode: 0o755 });
      fs.writeFileSync(
        probed,
        `#!/bin/sh\nprintf "selected:%s\\n" "\${NEXUS_CLAUDE_PROGRAM-unset}"\n`,
        { mode: 0o755 },
      );
      const result = spawnSync("bash", [WRAPPER_PATH], {
        encoding: "utf8",
        env: {
          HOME: dir,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          NEXUS_IN_APP: "0",
          NEXUS_CLAUDE_PROGRAM: probed,
        },
        timeout: 5000,
      });
      expect(result.stdout).toBe("selected:unset\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

let tmpDir: string;
let socketServer: net.Server;
let socketPath: string;

function createFakeClaude(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const fakePath = path.join(binDir, "claude");
  fs.writeFileSync(fakePath, "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(fakePath, 0o755);
}

function runWrapper(hookBin: string): {
  exitCode: number;
  settings: unknown;
  parseError?: string;
} {
  const fakeBinDir = path.join(tmpDir, "bin");
  createFakeClaude(fakeBinDir);

  const capturePath = path.join(tmpDir, "captured-settings.json");

  if (fs.existsSync(capturePath)) {
    fs.unlinkSync(capturePath);
  }

  const hookBinDir = path.dirname(hookBin);
  fs.mkdirSync(hookBinDir, { recursive: true });
  if (!fs.existsSync(hookBin)) {
    fs.writeFileSync(hookBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(hookBin, 0o755);
  }

  const result = spawnSync("bash", [WRAPPER_PATH], {
    env: {
      NEXUS_IN_APP: "1",
      NEXUS_AGENT_SOCKET: socketPath,
      NEXUS_HOOK_TOKEN: "test-token-abc",
      NEXUS_AGENT_BIN: hookBin,
      NEXUS_CAPTURE_SETTINGS_TO: capturePath,
      HOME: path.join(tmpDir, "home"),
      PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
    },
    timeout: 5000,
  });

  const exitCode = result.status ?? -1;

  if (!fs.existsSync(capturePath)) {
    return { exitCode, settings: null, parseError: "capture file not created" };
  }

  const raw = fs.readFileSync(capturePath, "utf8");
  try {
    const settings = JSON.parse(raw);
    return { exitCode, settings };
  } catch (err) {
    return {
      exitCode,
      settings: null,
      parseError: `JSON.parse failed: ${(err as Error).message}\n---\n${raw}`,
    };
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wrapper-test-"));

  socketPath = path.join(tmpDir, "agent.sock");
  socketServer = net.createServer();
  await new Promise<void>((resolve) => {
    socketServer.listen(socketPath, resolve);
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    socketServer.close(() => resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describeOnPosix("claude-wrapper.sh — NEXUS_AGENT_BIN 의무화", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the test is about the literal ${NEXUS_AGENT_BIN} text.
  test("NEXUS_AGENT_BIN 설정 시 settings.json command 필드에 리터럴 ${NEXUS_AGENT_BIN}이 포함된다", () => {
    const hookBin = path.join(tmpDir, "agent bin path", "agent-darwin");
    const { exitCode, settings, parseError } = runWrapper(hookBin);

    expect(parseError).toBeUndefined();
    expect(exitCode).toBe(0);
    expect((settings as Record<string, unknown>)["preferredNotifChannel"]).toBe(
      "notifications_disabled",
    );

    const hooks = (settings as Record<string, unknown>)["hooks"] as Record<string, unknown>;
    for (const event of HOOK_EVENT_NAMES) {
      const eventKey = toHookKey(event);
      const cmd = (hooks[eventKey] as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0]
        .command;
      expect(cmd).toBe(`"\${NEXUS_AGENT_BIN}" hook ${event}`);
    }

    expect(hooks.WorktreeCreate).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `"\${NEXUS_AGENT_BIN}" cli worktree claude-create -`,
            timeout: 300,
          },
        ],
      },
    ]);
    expect(hooks.WorktreeRemove).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `"\${NEXUS_AGENT_BIN}" cli worktree claude-remove -`,
            timeout: 300,
          },
        ],
      },
    ]);

    const sessionStart = (hooks.SessionStart as Array<{ hooks: unknown[] }>)[0].hooks;
    expect(sessionStart[1]).toEqual({
      type: "command",
      command: `"\${NEXUS_AGENT_BIN}" cli agent-context --launch="\${NEXUS_CHAT_INSTRUCTION_LAUNCH}" --profile="\${NEXUS_TERMINAL_PROFILE_ID}" -`,
      timeout: 10,
    });

    expect((hooks.PreToolUse as unknown[])[1]).toEqual({
      matcher: "SendMessage",
      hooks: [{ type: "command", command: `"\${NEXUS_AGENT_BIN}" hook send-message`, timeout: 5 }],
    });
  });

  test("NEXUS_AGENT_BIN 미설정 시 stderr 경고 출력 + settings 주입 없이 passthrough한다", () => {
    const fakeBinDir = path.join(tmpDir, "bin");
    createFakeClaude(fakeBinDir);

    const capturePath = path.join(tmpDir, "captured-settings.json");

    const result = spawnSync("bash", [WRAPPER_PATH], {
      env: {
        NEXUS_IN_APP: "1",
        NEXUS_AGENT_SOCKET: socketPath,
        NEXUS_HOOK_TOKEN: "test-token-abc",
        NEXUS_CAPTURE_SETTINGS_TO: capturePath,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
      timeout: 5000,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(capturePath)).toBe(false);
    expect(result.stderr).toContain("NEXUS_AGENT_BIN is not set");
    expect(result.stderr).toContain("hook injection skipped");
  });
});

describeOnPosix("claude-wrapper.sh — the settings file", () => {
  function launch(
    home: string | undefined,
    env: Record<string, string> = {},
  ): {
    status: number | null;
    settingsPath: string;
    stderr: string;
  } {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "claude");
    fs.writeFileSync(
      fake,
      '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do [[ "$1" == --settings ]] && printf "%s" "$2"; shift; done\n',
    );
    fs.chmodSync(fake, 0o755);
    const hookBin = path.join(tmpDir, "agent");
    fs.writeFileSync(hookBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(hookBin, 0o755);
    const result = spawnSync("bash", [WRAPPER_PATH], {
      env: {
        NEXUS_IN_APP: "1",
        NEXUS_AGENT_SOCKET: socketPath,
        NEXUS_AGENT_BIN: hookBin,
        ...(home === undefined ? {} : { HOME: home }),
        PATH: `${binDir}:/bin:/usr/bin`,
        ...env,
      },
      timeout: 5000,
      encoding: "utf8",
    });
    return { status: result.status, settingsPath: result.stdout, stderr: result.stderr };
  }

  test("every launch shares one file under ~/.nexus-code and leaves nothing else behind", () => {
    const home = path.join(tmpDir, "home");
    const first = launch(home);
    const second = launch(home);
    expect(first.status).toBe(0);
    expect(first.settingsPath).toMatch(/\/\.nexus-code\/claude-settings-\d+\.json$/);
    expect(second.settingsPath).toBe(first.settingsPath);
    expect(fs.readdirSync(path.join(home, ".nexus-code"))).toEqual([
      path.basename(first.settingsPath),
    ]);
    expect(JSON.parse(fs.readFileSync(first.settingsPath, "utf8")).hooks.Stop).toBeDefined();
  });

  test("writes it in the directory NEXUS_CODE_HOME names, for a copy of the app beside the installed one", () => {
    const home = path.join(tmpDir, "home");
    const named = path.join(tmpDir, "qa");
    const { status, settingsPath } = launch(home, { NEXUS_CODE_HOME: named });
    expect(status).toBe(0);
    expect(path.dirname(settingsPath)).toBe(named);
    expect(fs.existsSync(path.join(home, ".nexus-code"))).toBe(false);
  });

  test("rewrites a file whose content is not the settings", () => {
    const home = path.join(tmpDir, "home");
    const { settingsPath } = launch(home);
    fs.writeFileSync(settingsPath, "{");
    expect(launch(home).settingsPath).toBe(settingsPath);
    expect(() => JSON.parse(fs.readFileSync(settingsPath, "utf8"))).not.toThrow();
    expect(fs.readdirSync(path.join(home, ".nexus-code"))).toHaveLength(1);
  });

  test("runs claude without hooks when there is no home to write the file in", () => {
    const { status, settingsPath, stderr } = launch(undefined);
    expect(status).toBe(0);
    expect(settingsPath).toBe("");
    expect(stderr).toContain("hook injection skipped");
  });
});

describeOnPosix("claude-wrapper.sh — claude's arguments", () => {
  function argsGiven(args: string[]): string[] {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "claude");
    fs.writeFileSync(fake, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
    fs.chmodSync(fake, 0o755);
    const hookBin = path.join(tmpDir, "agent");
    fs.writeFileSync(hookBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(hookBin, 0o755);
    const result = spawnSync("bash", [WRAPPER_PATH, ...args], {
      env: {
        NEXUS_IN_APP: "1",
        NEXUS_AGENT_SOCKET: socketPath,
        NEXUS_AGENT_BIN: hookBin,
        HOME: path.join(tmpDir, "home"),
        PATH: `${binDir}:/bin:/usr/bin`,
      },
      timeout: 5000,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return result.stdout.split("\n").filter((line) => line !== "");
  }

  test("gives claude the hooks and the user's arguments, and no session id", () => {
    for (const args of [[], ["--continue"], ["-r", "abc"], ["--resume"], ["-p", "hi there"]]) {
      const given = argsGiven(args);
      expect(given[0]).toBe("--settings");
      expect(given.slice(2)).toEqual(args);
    }
  });
});

describeOnPosix("claude-wrapper.sh — a `claude -p` run", () => {
  function printMark(args: string[], env: Record<string, string> = {}): string {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "claude");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a bash script, which expands it.
    fs.writeFileSync(fake, '#!/usr/bin/env bash\nprintf "%s" "${NEXUS_CLAUDE_PRINT:-unset}"\n');
    fs.chmodSync(fake, 0o755);
    const hookBin = path.join(tmpDir, "agent");
    fs.writeFileSync(hookBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(hookBin, 0o755);
    const result = spawnSync("bash", [WRAPPER_PATH, ...args], {
      env: {
        NEXUS_IN_APP: "1",
        NEXUS_AGENT_SOCKET: socketPath,
        NEXUS_AGENT_BIN: hookBin,
        HOME: path.join(tmpDir, "home"),
        PATH: `${binDir}:/bin:/usr/bin`,
        ...env,
      },
      timeout: 5000,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return result.stdout;
  }

  test("marks a print run, so its permission requests are answered at once", () => {
    expect(printMark(["-p", "hi"])).toBe("1");
    expect(printMark(["--model", "opus", "--print", "hi"])).toBe("1");
  });

  test("leaves an interactive claude unmarked, whatever it inherits", () => {
    expect(printMark([])).toBe("0");
    expect(printMark(["--continue"], { NEXUS_CLAUDE_PRINT: "1" })).toBe("0");
    expect(printMark(["--", "-p"])).toBe("0");
  });

  test("waits on a permission request longer than the app holds it", () => {
    const { settings } = runWrapper(path.join(tmpDir, "agent"));
    const hooks = (
      settings as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> }
    ).hooks;
    expect(hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBeGreaterThan(3600);
  });
});

describeOnPosix("claude-wrapper.sh — a claude inside the tab's Claude session", () => {
  function launch(
    env: Record<string, string>,
    args: string[] = ["-p", "hi"],
  ): { hooks: boolean; mark: string; stdout: string; claude: string } {
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "claude");
    fs.writeFileSync(
      fake,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a bash script, which expands it.
      '#!/usr/bin/env bash\nhooks=no\nfor a in "$@"; do [[ "$a" == --settings ]] && hooks=yes; done\nprintf "%s %s" "$hooks" "${NEXUS_CLAUDE_TAB_ID:-}"\n',
    );
    fs.chmodSync(fake, 0o755);
    const hookBin = path.join(tmpDir, "agent");
    fs.writeFileSync(hookBin, '#!/usr/bin/env bash\nprintf "agent %s" "$*"\n');
    fs.chmodSync(hookBin, 0o755);
    const result = spawnSync("bash", [WRAPPER_PATH, ...args], {
      env: {
        NEXUS_IN_APP: "1",
        NEXUS_AGENT_SOCKET: socketPath,
        NEXUS_AGENT_BIN: hookBin,
        NEXUS_AGENT_PRINT_RUN: "1",
        NEXUS_TAB_ID: "t1",
        HOME: path.join(tmpDir, "home"),
        PATH: `${binDir}:/bin:/usr/bin`,
        ...env,
      },
      timeout: 5000,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const [hooks, mark = ""] = result.stdout.split(" ");
    return { hooks: hooks === "yes", mark, stdout: result.stdout, claude: fake };
  }

  test("the tab's claude gets the hooks, and its processes the tab's mark", () => {
    expect(launch({})).toMatchObject({ hooks: true, mark: "t1" });
  });

  test("a claude run by it gets none", () => {
    expect(launch({ NEXUS_CLAUDE_TAB_ID: "t1" }, ["hi"])).toMatchObject({
      hooks: false,
      mark: "t1",
    });
  });

  test("a `claude -p` run by it runs under the agent, which tells the app of it", () => {
    const run = launch({ NEXUS_CLAUDE_TAB_ID: "t1" }, [
      "-p",
      "hi",
      "--output-format",
      "stream-json",
    ]);
    expect(run.stdout).toBe(`agent print-run ${run.claude} -p hi --output-format stream-json`);
  });

  test("a `claude -p` run by it runs alone when there is no agent to run it", () => {
    expect(
      launch({ NEXUS_CLAUDE_TAB_ID: "t1", NEXUS_AGENT_BIN: path.join(tmpDir, "none") }),
    ).toMatchObject({ hooks: false, mark: "t1" });
  });

  test("a `claude -p` run by it runs alone when its agent cannot run it", () => {
    expect(launch({ NEXUS_CLAUDE_TAB_ID: "t1", NEXUS_AGENT_PRINT_RUN: "" })).toMatchObject({
      hooks: false,
      mark: "t1",
    });
  });

  test("a mark of another tab is not the tab's session", () => {
    expect(launch({ NEXUS_CLAUDE_TAB_ID: "t0" })).toMatchObject({ hooks: true, mark: "t1" });
  });
});

describeOnPosix("claude-wrapper.sh — 다른 wrapper 회피 (무한 루프 방지)", () => {
  test("PATH 에 wrapper 마커 후보가 있어도 진짜 claude 까지 fall-through 한다", () => {
    const fakeWrapperDir = path.join(tmpDir, "fake-cmux-bin");
    fs.mkdirSync(fakeWrapperDir, { recursive: true });
    const fakeWrapperPath = path.join(fakeWrapperDir, "claude");
    fs.writeFileSync(
      fakeWrapperPath,
      "#!/usr/bin/env bash\n# cmux claude wrapper - injects hooks\necho FAKE_WRAPPER_CALLED\nexit 0\n",
    );
    fs.chmodSync(fakeWrapperPath, 0o755);

    const realDir = path.join(tmpDir, "real-bin");
    fs.mkdirSync(realDir, { recursive: true });
    const realPath = path.join(realDir, "claude");
    fs.writeFileSync(realPath, "#!/usr/bin/env bash\necho REAL_CLAUDE_CALLED\nexit 0\n");
    fs.chmodSync(realPath, 0o755);

    const result = spawnSync("bash", [WRAPPER_PATH], {
      env: {
        PATH: `${fakeWrapperDir}:${realDir}:/bin:/usr/bin`,
      },
      timeout: 5000,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REAL_CLAUDE_CALLED");
    expect(result.stdout).not.toContain("FAKE_WRAPPER_CALLED");
  });
});

describeOnPosix("claude-wrapper.sh — NEXUS_WRAPPER_SELF_DIR SSH 시나리오", () => {
  test("NEXUS_WRAPPER_SELF_DIR 설정 시 해당 디렉터리의 claude를 self로 skip한다", () => {
    const sshBinDir = path.join(tmpDir, "home", "u", ".nexus-code", "bin");
    fs.mkdirSync(sshBinDir, { recursive: true });
    const sshClaude = path.join(sshBinDir, "claude");
    fs.writeFileSync(sshClaude, "#!/usr/bin/env bash\necho SSH_SELF_CALLED\nexit 0\n");
    fs.chmodSync(sshClaude, 0o755);

    const realDir = path.join(tmpDir, "usr", "local", "bin");
    fs.mkdirSync(realDir, { recursive: true });
    const realClaude = path.join(realDir, "claude");
    fs.writeFileSync(realClaude, "#!/usr/bin/env bash\necho REAL_CLAUDE_CALLED\nexit 0\n");
    fs.chmodSync(realClaude, 0o755);

    const result = spawnSync("bash", [WRAPPER_PATH], {
      env: {
        NEXUS_WRAPPER_SELF_DIR: sshBinDir,
        PATH: `${sshBinDir}:${realDir}:/bin:/usr/bin`,
      },
      timeout: 5000,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REAL_CLAUDE_CALLED");
    expect(result.stdout).not.toContain("SSH_SELF_CALLED");
  });
});

describeInGitBash("claude-wrapper.sh — Git Bash on Windows", () => {
  function runInGitBash(socket: string) {
    const fakeBinDir = path.join(tmpDir, "bin");
    createFakeClaude(fakeBinDir);
    const capturePath = path.join(tmpDir, "captured-settings.json");
    const result = spawnSync(GIT_BASH, [WRAPPER_PATH], {
      env: {
        ...process.env,
        NEXUS_IN_APP: "1",
        NEXUS_AGENT_SOCKET: socket,
        NEXUS_AGENT_BIN: path.join(tmpDir, "nexuscode-agent.exe"),
        NEXUS_CAPTURE_SETTINGS_TO: capturePath,
        PATH: `${fakeBinDir};${process.env.PATH ?? ""}`,
      },
      timeout: 10000,
    });
    return { exitCode: result.status, injected: fs.existsSync(capturePath) };
  }

  test("takes the agent's socket, a plain file to it, for the app's", () => {
    const socket = path.join(tmpDir, "h-test.sock");
    fs.writeFileSync(socket, "");
    expect(runInGitBash(socket)).toEqual({ exitCode: 0, injected: true });
  }, 20_000);

  test("passes claude through without the socket", () => {
    expect(runInGitBash(path.join(tmpDir, "missing.sock"))).toEqual({
      exitCode: 0,
      injected: false,
    });
  }, 20_000);
});

function toHookKey(event: (typeof HOOK_EVENT_NAMES)[number]): string {
  const map: Record<(typeof HOOK_EVENT_NAMES)[number], string> = {
    "session-start": "SessionStart",
    "user-prompt-submit": "UserPromptSubmit",
    "pre-tool-use": "PreToolUse",
    "post-tool-use": "PostToolUse",
    "post-tool-use-failure": "PostToolUseFailure",
    "subagent-start": "SubagentStart",
    "subagent-stop": "SubagentStop",
    notification: "Notification",
    stop: "Stop",
    "stop-failure": "StopFailure",
    "session-end": "SessionEnd",
    "permission-request": "PermissionRequest",
  };
  return map[event];
}
