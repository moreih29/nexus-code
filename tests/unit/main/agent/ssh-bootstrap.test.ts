import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  buildRemoteAgentCommand,
  ensureRemoteAgent,
  ensureRemoteLspServer,
  parseUname,
  remoteAgentBinaryPath,
  type SshBootstrapRunner,
} from "../../../../src/main/infra/agent/ssh/ssh-bootstrap/index";

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

function artifactMetadata(payload: Buffer): { sha256: string; size: number } {
  return {
    sha256: createHash("sha256").update(payload).digest("hex"),
    size: payload.byteLength,
  };
}

function writeDist(): {
  distDir: string;
  sha256: string;
  nodeSha256: string;
  lspSha256: string;
} {
  const distDir = path.join(tmpDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(distDir, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(distDir, "lsp"), { recursive: true });

  const agentPayload = Buffer.from("fake-linux-amd64-server");
  const agent = artifactMetadata(agentPayload);
  fs.writeFileSync(path.join(distDir, "agent-0.1.0-linux-amd64"), agentPayload);

  const nodePayload = Buffer.from("fake-node-runtime");
  const node = artifactMetadata(nodePayload);
  fs.writeFileSync(path.join(distDir, "runtime/node-v20.19.0-linux-x64.tar.gz"), nodePayload);

  const lspPayload = Buffer.from("fake-pyright-bundle");
  const lsp = artifactMetadata(lspPayload);
  fs.writeFileSync(path.join(distDir, "lsp/pyright-langserver-1.1.409.tar.gz"), lspPayload);

  fs.writeFileSync(
    path.join(distDir, "manifest.json"),
    JSON.stringify({
      version: "0.1.0",
      protocolVersion: "1",
      binaries: [
        {
          os: "linux",
          arch: "amd64",
          path: "agent-0.1.0-linux-amd64",
          sha256: agent.sha256,
          size: agent.size,
        },
      ],
      runtime: {
        node: [
          {
            os: "linux",
            arch: "amd64",
            version: "v20.19.0",
            path: "runtime/node-v20.19.0-linux-x64.tar.gz",
            sha256: node.sha256,
            size: node.size,
            entry: "bin/node",
          },
        ],
      },
      lspBinaries: [
        {
          name: "pyright-langserver",
          packageName: "pyright",
          version: "1.1.409",
          languages: ["python"],
          path: "lsp/pyright-langserver-1.1.409.tar.gz",
          sha256: lsp.sha256,
          size: lsp.size,
          entry: "node_modules/pyright/langserver.index.js",
          launcher: "bin/pyright-langserver",
          argsTemplate: ["--stdio"],
        },
      ],
    }),
  );
  return { distDir, sha256: agent.sha256, nodeSha256: node.sha256, lspSha256: lsp.sha256 };
}

function writeDistWithWrapper(): {
  distDir: string;
  sha256: string;
  wrapperSha256: string;
} {
  const { distDir, sha256 } = writeDist();
  const wrapperPayload = Buffer.from("fake-claude-wrapper-binary");
  const wrapper = artifactMetadata(wrapperPayload);
  fs.writeFileSync(path.join(distDir, "claude-wrapper"), wrapperPayload);
  // Overwrite manifest.json to include the wrapper field
  const existing = JSON.parse(
    fs.readFileSync(path.join(distDir, "manifest.json"), "utf8"),
  ) as object;
  fs.writeFileSync(
    path.join(distDir, "manifest.json"),
    JSON.stringify({
      ...existing,
      wrapper: {
        path: "claude-wrapper",
        sha256: wrapper.sha256,
        size: wrapper.size,
      },
    }),
  );
  return { distDir, sha256, wrapperSha256: wrapper.sha256 };
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
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
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
    // uname -ms + printf "$HOME" + cat manifest.json — no upload round trip.
    expect(runner).toHaveBeenCalledTimes(3);
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
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/user\n" };
      }
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
      if (command === "ssh" && remoteCommand.includes("cat > ~/.nexus-code/manifest.json")) {
        expect(typeof input).toBe("string");
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat >")) {
        expect(Buffer.isBuffer(input)).toBe(true);
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("index=0")) return { stdout: "" };
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
    expect(calls.some((call) => call.includes("index=0; for item in $(ls -1dt"))).toBe(true);
  });

  it("uploads remote node and LSP artifacts lazily and writes a remote launcher", async () => {
    const { distDir, nodeSha256, lspSha256 } = writeDist();
    const progress: unknown[] = [];
    const sftpInputs: string[] = [];
    let remoteManifest = "";
    let launcher = "";
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return { stdout: remoteManifest };
      }
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) {
        if (remoteCommand.includes("cat > ~/.nexus-code/manifest.json")) {
          remoteManifest = String(input);
        }
        if (remoteCommand.includes("bin/pyright-langserver")) {
          launcher = String(input);
        }
        return { stdout: "" };
      }
      if (command === "sftp") {
        sftpInputs.push(String(input));
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("if command -v sha256sum")) {
        return {
          stdout: remoteCommand.includes("node-v20.19.0") ? `${nodeSha256}\n` : `${lspSha256}\n`,
        };
      }
      if (command === "ssh" && remoteCommand.startsWith("rm -rf")) return { stdout: "" };
      if (command === "ssh" && remoteCommand.startsWith("index=0")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const result = await ensureRemoteLspServer(
      {
        host: "dev.example.com",
        user: "deploy",
        remotePath: "/repo",
        binaryName: "pyright-langserver",
        languageId: "python",
      },
      {
        distDir,
        runner,
        now: () => new Date("2026-05-12T00:00:00.000Z"),
        onProgress: (event) => progress.push(event),
      },
    );

    expect(result.binaryPath).toBe(
      "/home/deploy/.nexus-code/lsp/pyright-langserver-1.1.409/bin/pyright-langserver",
    );
    expect(result.args).toEqual(["--stdio"]);
    expect(result.uploaded).toBe(true);
    expect(sftpInputs).toHaveLength(2);
    expect(sftpInputs[0]).toContain(".nexus-code/cache/node-v20.19.0-linux-x64.tar.gz");
    expect(sftpInputs[1]).toContain(".nexus-code/cache/pyright-langserver-1.1.409.tar.gz");
    expect(launcher).toContain(
      "/home/deploy/.nexus-code/runtime/node-v20.19.0-linux-amd64/bin/node",
    );
    expect(launcher).toContain(
      "/home/deploy/.nexus-code/lsp/pyright-langserver-1.1.409/node_modules/pyright/langserver.index.js",
    );
    expect(progress).toContainEqual({
      name: "pyright-langserver",
      phase: "uploading",
      bytesDone: 0,
      bytesTotal: Buffer.from("fake-pyright-bundle").byteLength,
    });
    expect(progress).toContainEqual({ name: "pyright-langserver", phase: "ready" });
  });

  it("deduplicates concurrent lazy artifact uploads by sha", async () => {
    const { distDir, nodeSha256, lspSha256 } = writeDist();
    let remoteManifest = "";
    let sftpCount = 0;
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return { stdout: remoteManifest };
      }
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) {
        if (remoteCommand.includes("cat > ~/.nexus-code/manifest.json")) {
          remoteManifest = String(input);
        }
        return { stdout: "" };
      }
      if (command === "sftp") {
        sftpCount += 1;
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("if command -v sha256sum")) {
        return {
          stdout: remoteCommand.includes("node-v20.19.0") ? `${nodeSha256}\n` : `${lspSha256}\n`,
        };
      }
      if (command === "ssh" && remoteCommand.startsWith("rm -rf")) return { stdout: "" };
      if (command === "ssh" && remoteCommand.startsWith("index=0")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    await Promise.all([
      ensureRemoteLspServer(
        {
          host: "dev.example.com",
          user: "deploy",
          remotePath: "/repo",
          binaryName: "pyright-langserver",
          languageId: "python",
        },
        { distDir, runner },
      ),
      ensureRemoteLspServer(
        {
          host: "dev.example.com",
          user: "deploy",
          remotePath: "/repo",
          binaryName: "pyright-langserver",
          languageId: "python",
        },
        { distDir, runner },
      ),
    ]);

    expect(sftpCount).toBe(2);
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
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/alice\n" };
      }
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

    // Dispose schedules the socket unlink to run after the `ssh -O exit`
    // helper closes (or after a fallback timer); wait until either fires.
    const unlinkSeen = new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (unlinkCalls.length > 0) return resolve();
        if (Date.now() - start > 6_000) return resolve();
        setTimeout(tick, 25);
      };
      tick();
    });
    result.dispose?.();
    await unlinkSeen;
    expect(unlinkCalls).toEqual([result.controlPath]);
  });

  // ── Acceptance tests for Task 4: wrapper SFTP upload + remoteBinDir ──

  it("acceptance-1: uploads wrapper exactly once when manifest.wrapper is set", async () => {
    const { distDir, sha256, wrapperSha256 } = writeDistWithWrapper();
    const sftpInputs: string[] = [];
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) return { stdout: "" };
      if (command === "sftp") {
        sftpInputs.push(String(input));
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("if command -v sha256sum")) {
        const isWrapper = remoteCommand.includes("bin/claude");
        return { stdout: `${isWrapper ? wrapperSha256 : sha256}\n` };
      }
      if (command === "ssh" && remoteCommand.includes("cat > ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("index=0")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    await ensureRemoteAgent(
      { host: "dev.example.com", user: "deploy", remotePath: "/repo" },
      { distDir, runner, now: () => new Date("2026-05-12T00:00:00.000Z") },
    );

    // Exactly two SFTP calls: one for the agent binary, one for the wrapper
    const wrapperSftpInputs = sftpInputs.filter((s) => s.includes(".nexus-code/bin/claude"));
    const agentSftpInputs = sftpInputs.filter((s) => s.includes("bin/agent-"));
    expect(wrapperSftpInputs).toHaveLength(1);
    expect(agentSftpInputs).toHaveLength(1);
    // Wrapper upload must include chmod 755
    expect(wrapperSftpInputs[0]).toContain("chmod 755");
  });

  it("acceptance-2: skips wrapper upload when manifest.wrapper is undefined", async () => {
    const { distDir, sha256 } = writeDist();
    const sftpInputs: string[] = [];
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) return { stdout: "" };
      if (command === "sftp") {
        sftpInputs.push(String(input));
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("if command -v sha256sum")) {
        return { stdout: `${sha256}\n` };
      }
      if (command === "ssh" && remoteCommand.includes("cat > ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("index=0")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    await ensureRemoteAgent(
      { host: "dev.example.com", user: "deploy", remotePath: "/repo" },
      { distDir, runner, now: () => new Date("2026-05-12T00:00:00.000Z") },
    );

    // No SFTP call targeting bin/claude
    const wrapperSftpInputs = sftpInputs.filter((s) => s.includes(".nexus-code/bin/claude"));
    expect(wrapperSftpInputs).toHaveLength(0);
  });

  it("acceptance-3: SFTP uploadFile passes executable=true and issues chmod 755 for wrapper", async () => {
    const { distDir, sha256, wrapperSha256 } = writeDistWithWrapper();
    const sftpBatchInputs: string[] = [];
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) return { stdout: "" };
      if (command === "sftp") {
        sftpBatchInputs.push(String(input));
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("if command -v sha256sum")) {
        // Return the correct sha256 based on which file is being verified
        const isWrapper = remoteCommand.includes("bin/claude");
        return { stdout: `${isWrapper ? wrapperSha256 : sha256}\n` };
      }
      if (command === "ssh" && remoteCommand.includes("cat > ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("index=0")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    await ensureRemoteAgent(
      { host: "dev.example.com", user: "deploy", remotePath: "/repo" },
      { distDir, runner, now: () => new Date("2026-05-12T00:00:00.000Z") },
    );

    // The SFTP batch for the wrapper must contain chmod 755 (mode preservation)
    const wrapperBatch = sftpBatchInputs.find((s) => s.includes(".nexus-code/bin/claude"));
    expect(wrapperBatch).toBeDefined();
    expect(wrapperBatch).toContain("chmod 755");
  });

  it("acceptance-4: EnsureRemoteAgentResult exposes remoteBinDir as absolute path", async () => {
    const { distDir, sha256 } = writeDist();
    const runner = mock(async (command: string, args: string[]) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
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

    expect(result.remoteBinDir).toBeDefined();
    expect(result.remoteBinDir.startsWith("/")).toBe(true);
    expect(result.remoteBinDir).toBe("/home/deploy/.nexus-code/bin");
  });
});
