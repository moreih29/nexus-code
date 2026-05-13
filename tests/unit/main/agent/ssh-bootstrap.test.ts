import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  buildRemoteAgentCommand,
  ensureRemoteAgent,
  parseUname,
  remoteAgentBinaryPath,
  type SshBootstrapRunner,
} from "../../../../src/main/agent/ssh-bootstrap";

let tmpDir: string;

class FakePty {
  readonly writes: string[] = [];
  private readonly data = new EventEmitter();
  private readonly exit = new EventEmitter();

  onData(callback: (data: string) => void): { dispose(): void } {
    this.data.on("data", callback);
    return { dispose: () => this.data.off("data", callback) };
  }

  onExit(callback: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exit.on("exit", callback);
    return { dispose: () => this.exit.off("exit", callback) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(): void {}

  emitData(data: string): void {
    this.data.emit("data", data);
  }

  emitExit(exitCode: number): void {
    this.exit.emit("exit", { exitCode });
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bootstrap-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDist(): { distDir: string; sha256: string } {
  const distDir = path.join(tmpDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const payload = Buffer.from("fake-linux-amd64-server");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  fs.writeFileSync(path.join(distDir, "agent-0.1.0-linux-amd64"), payload);
  fs.writeFileSync(
    path.join(distDir, "manifest.json"),
    JSON.stringify({
      version: "0.1.0",
      protocolVersion: "1",
      binaries: [{ os: "linux", arch: "amd64", path: "agent-0.1.0-linux-amd64", sha256 }],
    }),
  );
  return { distDir, sha256 };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ssh-bootstrap", () => {
  it("parses supported uname output", () => {
    expect(parseUname("Linux x86_64\n")).toEqual({ os: "linux", arch: "amd64" });
    expect(parseUname("Darwin arm64\n")).toEqual({ os: "darwin", arch: "arm64" });
  });

  it("skips upload when remote manifest matches", async () => {
    const { distDir, sha256 } = writeDist();
    const runner = mock(async (command: string, args: string[]) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return {
          stdout: JSON.stringify({
            version: "0.1.0",
            os: "linux",
            arch: "amd64",
            sha256,
            installedAt: "2026-05-12T00:00:00.000Z",
          }),
        };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const result = await ensureRemoteAgent(
      { host: "dev.example.com", user: "deploy", remotePath: "/repo" },
      { distDir, runner },
    );

    expect(result.uploaded).toBe(false);
    expect(result.platform).toEqual({ os: "linux", arch: "amd64" });
    expect(result.remoteCommand).toBe(
      buildRemoteAgentCommand(remoteAgentBinaryPath("0.1.0", result.platform), "/repo"),
    );
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("falls back from sftp to cat upload and retries sha256 mismatch once", async () => {
    const { distDir, sha256 } = writeDist();
    let verifyCount = 0;
    const calls: string[] = [];
    const sftpInputs: string[] = [];
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      calls.push(`${command} ${args.at(-1) ?? ""}`);
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) return { stdout: "" };
      if (command === "sftp") {
        sftpInputs.push(String(input));
        throw new Error("sftp disabled");
      }
      if (command === "ssh" && remoteCommand.startsWith("if command -v sha256sum")) {
        verifyCount += 1;
        return { stdout: verifyCount === 1 ? `${"0".repeat(64)}\n` : `${sha256}\n` };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat > ~/.nexus-code/manifest.json")) {
        expect(typeof input).toBe("string");
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat >")) {
        expect(Buffer.isBuffer(input)).toBe(true);
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("ls -1t")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const result = await ensureRemoteAgent(
      { host: "dev.example.com", remotePath: "/repo" },
      { distDir, runner, now: () => new Date("2026-05-12T00:00:00.000Z") },
    );

    expect(result.uploaded).toBe(true);
    expect(verifyCount).toBe(2);
    expect(calls.filter((call) => call.startsWith("sftp"))).toHaveLength(2);
    expect(sftpInputs[0]).toContain(".nexus-code/bin/agent-0.1.0-linux-amd64");
    expect(sftpInputs[0]).not.toContain("~/.nexus-code");
    expect(calls.some((call) => call.includes("tail -n +4"))).toBe(true);
  });

  it("authenticates interactively once and bootstraps over the resulting ControlMaster", async () => {
    const { distDir, sha256 } = writeDist();
    const pty = new FakePty();
    const unlinkCalls: string[] = [];
    const sshArgs: string[][] = [];
    const runner = mock(async (command: string, args: string[]) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh") sshArgs.push(args);
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return {
          stdout: JSON.stringify({
            version: "0.1.0",
            os: "linux",
            arch: "amd64",
            sha256,
            installedAt: "2026-05-12T00:00:00.000Z",
          }),
        };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const resultPromise = ensureRemoteAgent(
      {
        host: "127.0.0.1",
        user: "alice",
        port: 2223,
        remotePath: "/workspace-seed",
        authMode: "interactive",
      },
      {
        distDir,
        runner,
        promptHandler: async (prompt) => ({
          kind: "password",
          promptId: prompt.promptId,
          value: "secret",
        }),
        auth: {
          promptIdPrefix: "bootstrap-auth",
          spawnPty: () => pty as never,
          unlink: (path) => unlinkCalls.push(path),
        },
      },
    );

    pty.emitData("alice@127.0.0.1's password:");
    await flushMicrotasks();
    pty.emitExit(0);

    const result = await resultPromise;

    expect(pty.writes).toEqual(["secret\r"]);
    expect(result.controlPath).toContain("control.sock");
    expect(result.dispose).toBeDefined();
    expect(
      sshArgs.every((args) => args.includes("-S") && args.includes(result.controlPath ?? "")),
    ).toBe(true);

    result.dispose?.();
    expect(unlinkCalls).toEqual([result.controlPath]);
  });
});
