/**
 * claude-wrapper.sh tests.
 *
 * Each test puts a fake `claude` on PATH, runs the wrapper under bash and
 * checks the settings it writes or which claude it execs. In-app runs also
 * need a listening Unix socket at NEXUS_AGENT_SOCKET; the generated settings
 * JSON is captured through NEXUS_CAPTURE_SETTINGS_TO.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const WRAPPER_PATH = path.resolve(import.meta.dir, "../../../scripts/assets/claude-wrapper.sh");

// The wrapper runs under bash where claude does: macOS and Linux, locally or
// on an SSH host, and Git Bash on Windows, which has its own tests below.
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
  "notification",
  "stop",
  "session-end",
  "permission-request",
] as const;

let tmpDir: string;
let socketServer: net.Server;
let socketPath: string;

/**
 * 가짜 claude 실행 파일을 tmpDir/bin/claude로 생성한다.
 * 래퍼가 exec 하면 이 스크립트가 실행되어 즉시 exit 0 한다.
 */
function createFakeClaude(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const fakePath = path.join(binDir, "claude");
  fs.writeFileSync(fakePath, "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(fakePath, 0o755);
}

/**
 * 래퍼 스크립트를 실행해 생성된 settings JSON을 반환한다.
 * NEXUS_CAPTURE_SETTINGS_TO에 캡처 경로를 지정해 exec 이전에 복사된 파일을 읽는다.
 */
function runWrapper(hookBin: string): {
  exitCode: number;
  settings: unknown;
  parseError?: string;
} {
  const fakeBinDir = path.join(tmpDir, "bin");
  createFakeClaude(fakeBinDir);

  const capturePath = path.join(tmpDir, "captured-settings.json");

  // 이미 존재하는 캡처 파일 제거 (여러 번 호출 시 오염 방지)
  if (fs.existsSync(capturePath)) {
    fs.unlinkSync(capturePath);
  }

  // 가짜 hook 바이너리 파일 생성 (실행 가능해야 HOOK_BIN 검증 통과)
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

  // Unix domain socket 생성 (-S 검사 충족)
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
  /**
   * Acceptance 1: NEXUS_AGENT_BIN이 설정되면 settings.json의 command 필드에
   * 리터럴 "${NEXUS_AGENT_BIN}" hook <sub> 형태가 기록된다.
   * (경로 자체가 아닌 변수 참조가 그대로 저장되어야 한다.)
   */
  test("NEXUS_AGENT_BIN 설정 시 settings.json command 필드에 리터럴 ${NEXUS_AGENT_BIN}이 포함된다", () => {
    // A path with a space: the command must quote the variable, because the
    // shell that runs the hook expands it.
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
      // 리터럴 변수 참조가 command에 있어야 한다 (확장된 실제 경로가 아님).
      expect(cmd).toBe(`"\${NEXUS_AGENT_BIN}" hook ${event}`);
    }

    // The note on nexus: a second SessionStart hook, run in step so its
    // output reaches the session as context.
    const sessionStart = (hooks.SessionStart as Array<{ hooks: unknown[] }>)[0].hooks;
    expect(sessionStart[1]).toEqual({
      type: "command",
      command: `"\${NEXUS_AGENT_BIN}" cli agent-context`,
      timeout: 10,
    });
  });

  /**
   * Acceptance 2: NEXUS_AGENT_BIN 미설정 시 stderr에 경고를 출력하고
   * settings 파일을 생성하지 않으며 진짜 claude를 exec한다.
   */
  test("NEXUS_AGENT_BIN 미설정 시 stderr 경고 출력 + settings 주입 없이 passthrough한다", () => {
    const fakeBinDir = path.join(tmpDir, "bin");
    createFakeClaude(fakeBinDir);

    const capturePath = path.join(tmpDir, "captured-settings.json");

    const result = spawnSync("bash", [WRAPPER_PATH], {
      env: {
        NEXUS_IN_APP: "1",
        NEXUS_AGENT_SOCKET: socketPath,
        NEXUS_HOOK_TOKEN: "test-token-abc",
        // NEXUS_AGENT_BIN 미설정
        NEXUS_CAPTURE_SETTINGS_TO: capturePath,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
      },
      timeout: 5000,
      encoding: "utf8",
    });

    // 진짜 claude(fake)로 passthrough되므로 exit 0
    expect(result.status).toBe(0);
    // settings 파일이 생성되지 않아야 한다
    expect(fs.existsSync(capturePath)).toBe(false);
    // stderr에 경고 문구가 있어야 한다
    expect(result.stderr).toContain("NEXUS_AGENT_BIN is not set");
    expect(result.stderr).toContain("hook injection skipped");
  });
});

describeOnPosix("claude-wrapper.sh — 다른 wrapper 회피 (무한 루프 방지)", () => {
  /**
   * 시나리오: PATH 에 cmux 와 우리 wrapper 가 함께 있을 때, find_real_claude 가
   * 다른 wrapper 를 진짜 claude 로 오인해 서로 exec 하는 무한 루프에 빠지면 안 된다.
   * 헤더 첫 5 줄의 magic 마커("nexus-code claude wrapper" / "cmux claude wrapper")
   * 를 발견하면 그 후보를 skip 하고 다음으로 넘어가야 한다.
   */
  test("PATH 에 wrapper 마커 후보가 있어도 진짜 claude 까지 fall-through 한다", () => {
    // cmux 스타일 마커를 가진 fake wrapper.
    const fakeWrapperDir = path.join(tmpDir, "fake-cmux-bin");
    fs.mkdirSync(fakeWrapperDir, { recursive: true });
    const fakeWrapperPath = path.join(fakeWrapperDir, "claude");
    fs.writeFileSync(
      fakeWrapperPath,
      "#!/usr/bin/env bash\n# cmux claude wrapper - injects hooks\necho FAKE_WRAPPER_CALLED\nexit 0\n",
    );
    fs.chmodSync(fakeWrapperPath, 0o755);

    // 마커 없는 진짜 claude 역할.
    const realDir = path.join(tmpDir, "real-bin");
    fs.mkdirSync(realDir, { recursive: true });
    const realPath = path.join(realDir, "claude");
    fs.writeFileSync(realPath, "#!/usr/bin/env bash\necho REAL_CLAUDE_CALLED\nexit 0\n");
    fs.chmodSync(realPath, 0o755);

    // NEXUS_IN_APP 미설정 → 우리 wrapper 는 passthrough 모드.
    // fake-cmux 가 real 보다 PATH 우선순위 앞이어도 마커 검사로 skip 되어야 한다.
    // PATH 에 /bin·/usr/bin 도 포함해야 wrapper 내부의 head·grep 외부 명령이 동작한다.
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
  /**
   * Acceptance 3: NEXUS_WRAPPER_SELF_DIR이 /home/u/.nexus-code/bin (SSH 경로)으로 설정되면
   * find_real_claude가 그 디렉터리를 self로 skip하고 다음 후보를 선택한다.
   */
  test("NEXUS_WRAPPER_SELF_DIR 설정 시 해당 디렉터리의 claude를 self로 skip한다", () => {
    // SSH 배포 경로처럼 보이는 디렉터리에 wrapper 마커가 없는 가짜 claude를 배치.
    // (실제로는 이 경로가 self_dir이어서 skip되어야 한다.)
    const sshBinDir = path.join(tmpDir, "home", "u", ".nexus-code", "bin");
    fs.mkdirSync(sshBinDir, { recursive: true });
    const sshClaude = path.join(sshBinDir, "claude");
    fs.writeFileSync(sshClaude, "#!/usr/bin/env bash\necho SSH_SELF_CALLED\nexit 0\n");
    fs.chmodSync(sshClaude, 0o755);

    // 실제 선택되어야 할 진짜 claude.
    const realDir = path.join(tmpDir, "usr", "local", "bin");
    fs.mkdirSync(realDir, { recursive: true });
    const realClaude = path.join(realDir, "claude");
    fs.writeFileSync(realClaude, "#!/usr/bin/env bash\necho REAL_CLAUDE_CALLED\nexit 0\n");
    fs.chmodSync(realClaude, 0o755);

    const result = spawnSync("bash", [WRAPPER_PATH], {
      env: {
        // NEXUS_WRAPPER_SELF_DIR을 sshBinDir로 설정해 self skip 강제
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

  // Git Bash sees the agent's AF_UNIX socket as a plain file.
  test("takes the agent's socket, a plain file to it, for the app's", () => {
    const socket = path.join(tmpDir, "h-test.sock");
    fs.writeFileSync(socket, "");
    expect(runInGitBash(socket)).toEqual({ exitCode: 0, injected: true });
  });

  test("passes claude through without the socket", () => {
    expect(runInGitBash(path.join(tmpDir, "missing.sock"))).toEqual({
      exitCode: 0,
      injected: false,
    });
  });
});

/**
 * hook 이벤트 이름("session-start")을 JSON 키("SessionStart")로 변환한다.
 */
function toHookKey(event: (typeof HOOK_EVENT_NAMES)[number]): string {
  const map: Record<(typeof HOOK_EVENT_NAMES)[number], string> = {
    "session-start": "SessionStart",
    "user-prompt-submit": "UserPromptSubmit",
    "pre-tool-use": "PreToolUse",
    "notification": "Notification",
    "stop": "Stop",
    "session-end": "SessionEnd",
    "permission-request": "PermissionRequest",
  };
  return map[event];
}
