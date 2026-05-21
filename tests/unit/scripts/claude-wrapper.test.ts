/**
 * T11: claude-wrapper.sh JSON 이스케이프 검증 테스트
 *
 * 테스트 전략:
 *  1. 임시 디렉터리에 가짜 'claude' 실행 파일을 배치한다 (실제 claude 역할).
 *  2. Unix domain socket을 생성해 NEXUS_AGENT_SOCKET 요구 조건을 충족한다.
 *  3. NEXUS_AGENT_BIN에 공백/따옴표/백슬래시 등 특수 문자가 포함된 경로를 넣는다.
 *  4. 래퍼 스크립트가 생성한 settings JSON을 NEXUS_CAPTURE_SETTINGS_TO로 캡처한다.
 *  5. JSON.parse가 성공하고, 7개 훅 명령이 모두 문자열임을 검증한다.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const WRAPPER_PATH = path.resolve(import.meta.dir, "../../../scripts/assets/claude-wrapper.sh");
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

describe("claude-wrapper.sh — JSON 이스케이프 검증", () => {
  test("HOOK_BIN 경로에 공백이 포함되어도 유효한 JSON을 생성한다", () => {
    const hookBin = path.join(tmpDir, "agent bin path", "agent-darwin");

    const { exitCode, settings, parseError } = runWrapper(hookBin);

    expect(parseError).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(settings).not.toBeNull();

    // 7개 훅 이벤트가 모두 존재하고, command 값이 string이어야 한다.
    const hooks = (settings as Record<string, unknown>)["hooks"] as Record<string, unknown>;
    for (const event of HOOK_EVENT_NAMES) {
      const eventKey = toHookKey(event);
      const hookDef = (hooks[eventKey] as Array<{ hooks: Array<{ command: unknown }> }>)[0]
        .hooks[0];
      expect(typeof hookDef.command).toBe("string");
      // command 값에 hook 이벤트명이 포함되어야 한다.
      expect(hookDef.command as string).toContain(event);
    }
  });

  test("HOOK_BIN 경로에 큰따옴표가 포함되어도 유효한 JSON을 생성한다", () => {
    // 실제 파일시스템에서는 큰따옴표를 경로에 쓸 수 있다 (macOS/Linux).
    const hookBin = path.join(tmpDir, 'agent"bin', "agent-darwin");

    const { exitCode, settings, parseError } = runWrapper(hookBin);

    expect(parseError).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(settings).not.toBeNull();

    const hooks = (settings as Record<string, unknown>)["hooks"] as Record<string, unknown>;
    const sessionStartCmd = (
      hooks["SessionStart"] as Array<{ hooks: Array<{ command: string }> }>
    )[0].hooks[0].command;
    expect(typeof sessionStartCmd).toBe("string");
    expect(sessionStartCmd).toContain("session-start");
  });

  test("HOOK_BIN 경로에 백슬래시가 포함되어도 유효한 JSON을 생성한다", () => {
    // bash에서 경로 내 백슬래시는 드물지만 JSON 이스케이프 로직을 검증한다.
    const hookBin = path.join(tmpDir, "agent\\bin", "agent-darwin");

    const { exitCode, settings, parseError } = runWrapper(hookBin);

    expect(parseError).toBeUndefined();
    expect(exitCode).toBe(0);
    expect(settings).not.toBeNull();

    const hooks = (settings as Record<string, unknown>)["hooks"] as Record<string, unknown>;
    const sessionStartCmd = (
      hooks["SessionStart"] as Array<{ hooks: Array<{ command: string }> }>
    )[0].hooks[0].command;
    expect(typeof sessionStartCmd).toBe("string");
    expect(sessionStartCmd).toContain("session-start");
  });

  test("생성된 settings JSON에 preferredNotifChannel이 notifications_disabled로 설정된다", () => {
    const hookBin = path.join(tmpDir, "simple", "agent-darwin");

    const { exitCode, settings, parseError } = runWrapper(hookBin);

    expect(parseError).toBeUndefined();
    expect(exitCode).toBe(0);
    expect((settings as Record<string, unknown>)["preferredNotifChannel"]).toBe(
      "notifications_disabled",
    );
  });
});

describe("claude-wrapper.sh — 다른 wrapper 회피 (무한 루프 방지)", () => {
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
