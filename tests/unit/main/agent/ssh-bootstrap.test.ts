import { AGENT_PROTOCOL_VERSION } from "../../../../src/shared/agent/envelope";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildRemoteAgentCommand,
  computeWsId,
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
      protocolVersion: AGENT_PROTOCOL_VERSION,
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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
    // uname -ms + printf "$HOME" + echo "$SHELL" + cat manifest.json
    // — no upload round trip. The echo "$SHELL" probe throws ("unexpected
    // command") because this mock doesn't handle it; detectRemoteShell
    // swallows that error and returns undefined, so result.remoteShell stays
    // undefined. The call still counts toward the runner's invocation total.
    expect(runner).toHaveBeenCalledTimes(4);
    expect(result.remoteShell).toBeUndefined();
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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

  it("retries the full upload when the atomic rename fails on the first attempt", async () => {
    // Regression: `sftp` exits 0 even when a `put` silently fails, so the temp
    // file can be missing when `mv -f tmp final` runs — the rename then throws
    // "no such file" and aborts the bootstrap. The fix wraps each attempt so a
    // failed rename retries the full upload instead of propagating. Here the
    // first `mv` throws and the second succeeds; the bootstrap must recover.
    const { distDir, sha256 } = writeDist();
    let mvCount = 0;
    let rmCount = 0;
    const calls: string[] = [];
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      const remoteCommand = args.at(-1) ?? "";
      calls.push(`${command} ${remoteCommand}`);
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/user\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat ~/.nexus-code/manifest.json")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) return { stdout: "" };
      if (command === "sftp") return { stdout: "" };
      if (command === "ssh" && remoteCommand.startsWith("mv -f")) {
        mvCount += 1;
        // First attempt simulates a temp file that never landed (silent sftp
        // failure): the remote rename reports "no such file" and rejects.
        if (mvCount === 1) {
          throw new Error("zsh:1: no such file or directory: agent.tmp.deadbeef");
        }
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("rm -f")) {
        rmCount += 1;
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("if command -v sha256sum")) {
        return { stdout: `${sha256}\n` };
      }
      if (command === "ssh" && remoteCommand.includes("cat > ~/.nexus-code/manifest.json")) {
        expect(typeof input).toBe("string");
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
    expect(mvCount).toBe(2); // first rename failed, retry succeeded
    expect(rmCount).toBe(1); // orphaned temp from the failed attempt was cleaned
    expect(calls.filter((call) => call.startsWith("sftp"))).toHaveLength(2);
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
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

  it("detectRemoteShell: surfaces remote $SHELL as remoteShell when echo returns an absolute path", async () => {
    const { distDir, sha256 } = writeDist();
    const runner = mock(async (command: string, args: string[]) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("echo")) {
        // detectRemoteShell uses `echo "$SHELL"` — distinct prefix from
        // detectRemoteHome's `printf '%s\n' "$HOME"` so the mock can
        // distinguish them.
        return { stdout: "/bin/zsh\n" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const result = await ensureRemoteAgent(
      { host: "dev.example.com", user: "deploy", remotePath: "/repo" },
      { distDir, runner },
    );

    expect(result.remoteShell).toBe("/bin/zsh");
  });

  it("uploads PTY shim rc files when workspaceId is provided and surfaces remoteShimDir", async () => {
    const { distDir, sha256 } = writeDist();
    const uploadedShimContents = new Map<string, string>();
    const runner = mock(async (command: string, args: string[], input?: Buffer | string) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("echo")) {
        return { stdout: "/bin/zsh\n" };
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
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) {
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat >")) {
        // The shim files arrive as `cat > <remoteShimDir>/<name>` with
        // content streamed via stdin. `quoteShellArg` leaves the path
        // unquoted when it's all safe chars (alnum, `-`, `_`, `.`, `/`,
        // `~`, etc.), which is always the case for our shim paths — so we
        // capture everything after `cat > ` rather than expecting quotes.
        const match = remoteCommand.match(/^cat > (\S+)$/);
        if (match) {
          uploadedShimContents.set(match[1], String(input ?? ""));
        }
        return { stdout: "" };
      }
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const WS_ID = "ws-shim-upload-test";
    const result = await ensureRemoteAgent(
      {
        host: "dev.example.com",
        user: "deploy",
        remotePath: "/repo",
        workspaceId: WS_ID,
      },
      { distDir, runner },
    );

    // remoteShimDir must be the remote absolute path that mirrors the
    // local layout: `<remoteHome>/.nexus-code/shim/<workspaceId>`.
    expect(result.remoteShimDir).toBe(`/home/deploy/.nexus-code/shim/${WS_ID}`);

    // All three shim files must have been uploaded to that directory.
    const expectedZshrc = `/home/deploy/.nexus-code/shim/${WS_ID}/.zshrc`;
    const expectedZshenv = `/home/deploy/.nexus-code/shim/${WS_ID}/.zshenv`;
    const expectedBashrc = `/home/deploy/.nexus-code/shim/${WS_ID}/bashrc`;
    expect(uploadedShimContents.has(expectedZshrc)).toBe(true);
    expect(uploadedShimContents.has(expectedZshenv)).toBe(true);
    expect(uploadedShimContents.has(expectedBashrc)).toBe(true);

    // Content sanity: the zshrc must contain the precmd hook + the env var
    // it depends on. Bashrc must contain the PROMPT_COMMAND wiring.
    expect(uploadedShimContents.get(expectedZshrc)).toContain("_nexus_prepend_wrapper");
    expect(uploadedShimContents.get(expectedZshrc)).toContain("NEXUS_WRAPPER_SELF_DIR");
    expect(uploadedShimContents.get(expectedZshrc)).toContain("add-zsh-hook precmd");
    expect(uploadedShimContents.get(expectedBashrc)).toContain("PROMPT_COMMAND");
    expect(uploadedShimContents.get(expectedZshenv)).toContain("NEXUS_USER_ZDOTDIR");
  });

  it("omits PTY shim upload when workspaceId is not provided (LSP-only bootstrap stays compatible)", async () => {
    const { distDir, sha256 } = writeDist();
    let shimCatCalls = 0;
    const runner = mock(async (command: string, args: string[]) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("echo")) {
        return { stdout: "/bin/zsh\n" };
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
      if (command === "ssh" && remoteCommand.startsWith("mkdir -p")) {
        // Without workspaceId there must be no mkdir for the shim subdir.
        // Surface this by failing the test if we see a path starting with
        // `~/.nexus-code/shim/`.
        if (remoteCommand.includes("/.nexus-code/shim/")) {
          throw new Error(`unexpected shim mkdir: ${remoteCommand}`);
        }
        return { stdout: "" };
      }
      if (command === "ssh" && remoteCommand.startsWith("cat >")) {
        shimCatCalls += 1;
        return { stdout: "" };
      }
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const result = await ensureRemoteAgent(
      { host: "dev.example.com", user: "deploy", remotePath: "/repo" },
      { distDir, runner },
    );

    expect(result.remoteShimDir).toBeUndefined();
    // No `cat >` for shim files when no workspaceId is given.
    expect(shimCatCalls).toBe(0);
  });

  it("detectRemoteShell: returns undefined remoteShell when remote $SHELL is empty (graceful skip)", async () => {
    const { distDir, sha256 } = writeDist();
    const runner = mock(async (command: string, args: string[]) => {
      const remoteCommand = args.at(-1) ?? "";
      if (command === "ssh" && remoteCommand === "uname -ms") return { stdout: "Linux x86_64\n" };
      if (command === "ssh" && remoteCommand.startsWith("printf")) {
        return { stdout: "/home/deploy\n" };
      }
      if (command === "ssh" && remoteCommand.startsWith("echo")) {
        // Empty $SHELL on the remote (e.g. unset). Must NOT throw — the
        // caller's bootstrap should still succeed; we simply don't get a
        // shell hint and the shim is skipped downstream.
        return { stdout: "\n" };
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
      if (command === "ssh" && String(args.at(-1) ?? "").startsWith("mv -f")) return { stdout: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as SshBootstrapRunner;

    const result = await ensureRemoteAgent(
      { host: "dev.example.com", user: "deploy", remotePath: "/repo" },
      { distDir, runner },
    );

    expect(result.remoteShell).toBeUndefined();
    // Bootstrap itself must still have succeeded — remoteBinDir present.
    expect(result.remoteBinDir).toBe("/home/deploy/.nexus-code/bin");
  });
});

describe("buildRemoteAgentCommand (daemon+dial architecture)", () => {
  it("rejects relative remote paths", () => {
    expect(() => buildRemoteAgentCommand("/usr/local/bin/agent", "relative/path")).toThrow();
    expect(() => buildRemoteAgentCommand("/usr/local/bin/agent", "~/repo")).toThrow();
  });

  it("contains daemon background start and dial retry loop", () => {
    const cmd = buildRemoteAgentCommand("/home/user/.nexus-code/bin/agent", "/home/user/repo");
    // Must wrap in bash -lc
    expect(cmd).toMatch(/^bash -lc/);
    // Must include --daemon flag (started as grandchild via subshell)
    expect(cmd).toContain("--daemon");
    // Must include --dial flag (dialer as plain shell child, no exec)
    expect(cmd).toContain("--dial");
    // Daemon must be started in a subshell for fd isolation and detachment
    expect(cmd).toContain("( ");
    expect(cmd).toContain("& )");
    // Daemon fds must be isolated from ssh session to prevent NDJSON pollution
    expect(cmd).toContain("</dev/null");
    expect(cmd).toContain(">/dev/null");
    // Socket-not-ready exit code (4) triggers retry
    expect(cmd).toContain("$rc -ne 4");
    // No exec (dialer is a plain child, not foreground handoff via exec)
    expect(cmd).not.toContain("exec ");
    // No shopt execfail (not needed without exec)
    expect(cmd).not.toContain("shopt");
    // No wait (daemon is long-lived, blocking wait would hang forever)
    expect(cmd).not.toContain("wait ");
  });

  it("embeds the wsId-derived socket path matching computeWsId output", () => {
    const remotePath = "/home/user/my-project";
    const wsId = computeWsId(remotePath);
    expect(wsId).toHaveLength(16);
    expect(wsId).toMatch(/^[0-9a-f]{16}$/);

    const cmd = buildRemoteAgentCommand("/usr/bin/agent", remotePath);
    expect(cmd).toContain(wsId);
    expect(cmd).toContain(".sock");
  });

  it("computeWsId matches Go agentrun.WsID algorithm (sha256[:16])", () => {
    // Verified against Go: echo -n "/repo" | sha256sum → first 16 hex chars
    const createHashFn = createHash;
    const expected = createHashFn("sha256").update("/repo", "utf8").digest("hex").slice(0, 16);
    expect(computeWsId("/repo")).toBe(expected);
  });
});
