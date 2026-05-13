/**
 * Git helper IPC tests cover the real socket protocol used by askpass/editor
 * helpers plus pure launcher/path security seams.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildGitHelpersEndpoint,
  GitHelpersIpcManager,
  prepareGitHelpersEndpoint,
} from "../../../../src/main/git/git-helpers-ipc";
import { buildHelperEnv } from "../../../../src/main/git/helpers-launcher";
import type { AskpassPrompt, GitEditorPrompt } from "../../../../src/shared/types/git";

const ASKPASS_HELPER = path.join(process.cwd(), "src/main/git/askpass-helper.cjs");
const EDITOR_HELPER = path.join(process.cwd(), "src/main/git/git-editor-helper.cjs");

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("helpers-launcher", () => {
  it("buildHelperEnv returns askpass and editor helper variables", () => {
    const wrapperDir = makeTmpDir("nexus-helper-wrappers-");
    const env = buildHelperEnv(
      { askpass: true, editor: true },
      {
        connection: { socketPath: "/tmp/nexus.sock", token: "token-123" },
        electronPath: "/Applications/Nexus Code.app/Contents/MacOS/Nexus Code",
        helperDir: "/app/helpers",
        wrapperDir,
        baseEnv: {},
        platform: "linux",
      },
    );

    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.NEXUS_HELPERS_SOCKET).toBe("/tmp/nexus.sock");
    expect(env.NEXUS_HELPERS_TOKEN).toBe("token-123");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(env.GIT_EDITOR).toBe(path.join(wrapperDir, "nexus-git-editor-helper"));
    expect(env.DISPLAY).toBe(":0");

    expect(modeOf(env.GIT_EDITOR ?? "")).toBe(0o700);
    expect(fs.readFileSync(env.GIT_EDITOR ?? "", "utf8")).toContain("git-editor-helper.cjs");
    expect(env.GIT_EDITOR).not.toMatch(/^'.*' '.*'$/);
  });

  it("does not create an Electron-host askpass wrapper", () => {
    const wrapperDir = makeTmpDir("nexus-helper-wrappers-");
    const env = buildHelperEnv(
      { askpass: true },
      {
        connection: { socketPath: "/tmp/nexus.sock", token: "token-123" },
        electronPath: process.execPath,
        helperDir: "/app/helpers",
        wrapperDir,
        baseEnv: {},
        platform: process.platform,
      },
    );

    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(fs.existsSync(path.join(wrapperDir, "nexus-git-askpass-helper"))).toBe(false);
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
  });
});

describe("Git helper endpoint security", () => {
  it("uses Unix socket directory under userData with private permissions", async () => {
    const userDataDir = makeTmpDir("nexus-helper-user-data-");
    const endpoint = await prepareGitHelpersEndpoint({
      userDataDir,
      platform: "darwin",
      pid: 1234,
    });

    expect(endpoint.kind).toBe("unix");
    expect(endpoint.path).toBe(path.join(userDataDir, "nexus-helpers-1234.sock"));
    expect(modeOf(userDataDir)).toBe(0o700);
  });

  it("builds a Windows named pipe endpoint", () => {
    expect(buildGitHelpersEndpoint("C:/Users/me/AppData/Roaming/Nexus", "win32", 55)).toEqual({
      kind: "pipe",
      path: "\\\\.\\pipe\\nexus-helpers-55",
    });
  });

  it("rejects missing tokens and token requests for inactive prompt ids", async () => {
    const manager = new GitHelpersIpcManager({
      userDataDir: makeTmpDir("nexus-helper-auth-"),
      broadcast: () => {},
      token: "secret",
    });

    await expect(manager.handleHelperRequest({ route: "askpass.prompt" })).rejects.toThrow(
      /invalid token/,
    );
    await expect(
      manager.handleHelperRequest({
        route: "askpass.prompt",
        token: "secret",
        promptId: "inactive",
        prompt: "Username for 'https://example.com':",
      }),
    ).rejects.toThrow(/inactive prompt id/);
  });
});

describe("Git helper socket flows", () => {
  it("round-trips HTTPS username then password prompts through helper stdout", async () => {
    const userDataDir = makeTmpDir("nexus-helper-flow-");
    const values = ["alice", "s3cr3t"];
    const prompts: AskpassPrompt[] = [];
    const manager = new GitHelpersIpcManager({
      userDataDir,
      broadcast(channel, event, args) {
        expect(`${channel}.${event}`).toBe("askpass.prompt");
        const prompt = args as AskpassPrompt;
        prompts.push(prompt);
        setTimeout(
          () => manager.respondAskpass({ promptId: prompt.promptId, value: values.shift() }),
          0,
        );
      },
      token: "flow-token",
    });
    await manager.start();

    try {
      const connection = manager.connection();
      const username = await runNodeHelper(
        ASKPASS_HELPER,
        ["Username for 'https://example.com':"],
        {
          NEXUS_HELPERS_SOCKET: connection.socketPath,
          NEXUS_HELPERS_TOKEN: connection.token,
        },
      );
      const password = await runNodeHelper(
        ASKPASS_HELPER,
        ["Password for 'https://example.com':"],
        {
          NEXUS_HELPERS_SOCKET: connection.socketPath,
          NEXUS_HELPERS_TOKEN: connection.token,
        },
      );

      expect(username).toMatchObject({ code: 0, stdout: "alice" });
      expect(password).toMatchObject({ code: 0, stdout: "s3cr3t" });
      expect(prompts.map((prompt) => prompt.field)).toEqual(["username", "password"]);
    } finally {
      await manager.dispose();
    }
  });

  it("credential cancel exits helper 1", async () => {
    const userDataDir = makeTmpDir("nexus-helper-cancel-");
    const manager = new GitHelpersIpcManager({
      userDataDir,
      broadcast(_channel, _event, args) {
        const prompt = args as AskpassPrompt;
        setTimeout(() => manager.cancelAskpass({ promptId: prompt.promptId }), 0);
      },
      token: "cancel-token",
    });
    await manager.start();

    try {
      const connection = manager.connection();
      const result = await runNodeHelper(ASKPASS_HELPER, ["Username for 'https://example.com':"], {
        NEXUS_HELPERS_SOCKET: connection.socketPath,
        NEXUS_HELPERS_TOKEN: connection.token,
      });

      expect(result.code).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it("commit editor save writes the file and cancel truncates before helper exit 1", async () => {
    const userDataDir = makeTmpDir("nexus-helper-editor-");
    const commitFile = path.join(userDataDir, "COMMIT_EDITMSG");
    fs.writeFileSync(commitFile, "initial subject\n\n# comment\n", "utf8");

    let manager: GitHelpersIpcManager;
    const responses: Array<(prompt: GitEditorPrompt) => Promise<void> | void> = [
      (prompt) => manager.saveEditor({ promptId: prompt.promptId, content: "saved subject\n" }),
      (prompt) => manager.cancelEditor({ promptId: prompt.promptId }),
    ];
    manager = new GitHelpersIpcManager({
      userDataDir,
      broadcast(channel, event, args) {
        expect(`${channel}.${event}`).toBe("editor.prompt");
        const respond = responses.shift();
        if (!respond) throw new Error("unexpected editor prompt");
        setTimeout(() => {
          void respond(args as GitEditorPrompt);
        }, 0);
      },
      token: "editor-token",
    });
    await manager.start();

    try {
      const connection = manager.connection();
      const env = {
        NEXUS_HELPERS_SOCKET: connection.socketPath,
        NEXUS_HELPERS_TOKEN: connection.token,
      };
      const saved = await runNodeHelper(EDITOR_HELPER, [commitFile], env);
      expect(saved.code).toBe(0);
      expect(fs.readFileSync(commitFile, "utf8")).toBe("saved subject\n");

      fs.writeFileSync(commitFile, "will cancel\n", "utf8");
      const cancelled = await runNodeHelper(EDITOR_HELPER, [commitFile], env);
      expect(cancelled.code).toBe(1);
      expect(fs.readFileSync(commitFile, "utf8")).toBe("");
    } finally {
      await manager.dispose();
    }
  });
});

/**
 * Creates a tracked temporary directory for each test.
 */
function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/**
 * Returns POSIX mode bits for permission assertions.
 */
function modeOf(targetPath: string): number {
  return fs.statSync(targetPath).mode & 0o777;
}

/**
 * Runs a helper script in the current JavaScript runtime and captures output.
 */
function runNodeHelper(
  scriptPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
