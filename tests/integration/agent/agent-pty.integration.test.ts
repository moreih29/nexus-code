import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAgentPtyHost } from "../../../src/main/features/pty/agent-host";
import type { PtyHostHandle } from "../../../src/main/features/pty/types";
import type { AgentChannel } from "../../../src/main/infra/agent/channel";
import { createLocalChannel } from "../../../src/main/infra/agent/channel/local-channel";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HIGH_WATERMARK_BYTES = 100_000;
const LOW_WATERMARK_BYTES = 5_000;
const MAX_CHUNK_SIZE = 4 * 1024;

const goAvailable = spawnSync("go", ["version"]).status === 0;

describe("agent PTY full-path integration", () => {
  if (!goAvailable) {
    it("skips when go is unavailable", () => {});
    return;
  }

  let binPath: string;
  let buildDir: string;

  beforeAll(async () => {
    buildDir = await fs.mkdtemp(path.join(tmpdir(), "nexus-agent-pty-build-"));
    binPath = path.join(buildDir, "agent");
    const build = spawnSync("go", ["build", "-o", binPath, "./cmd/agent"], {
      cwd: REPO_ROOT,
    });
    if (build.status !== 0) {
      throw new Error(`go build failed: ${build.stderr.toString()}`);
    }
  });

  afterAll(async () => {
    await fs.rm(buildDir, { recursive: true, force: true });
  });

  it("spawns a shell and echoes renderer writes round-trip", async () => {
    const fixture = await PtyAgentFixture.create(binPath);
    try {
      const tabId = "echo-round-trip";
      await fixture.spawnScript(
        tabId,
        `
stty -echo
echo READY
while IFS= read -r line; do
  printf 'ECHO:%s\\n' "$line"
  [ "$line" = "quit" ] && exit 0
done
`,
      );

      await fixture.waitForTranscript(tabId, "READY");
      await fixture.write(tabId, "hello from renderer\n");
      await fixture.waitForTranscript(tabId, "ECHO:hello from renderer");
      await fixture.write(tabId, "quit\n");

      const exit = await fixture.waitForExit(tabId);
      expect(exit.code).toBe(0);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("preserves burst write ordering across PTY input chunking and NDJSON data events", async () => {
    const fixture = await PtyAgentFixture.create(binPath);
    try {
      const tabId = "burst-order";
      const frames = 1_000;
      await fixture.spawnScript(
        tabId,
        `
stty -echo
echo READY
i=0
while [ "$i" -lt ${frames} ]; do
  IFS= read -r line || exit 1
  printf '%s\\n' "$line"
  i=$((i + 1))
done
exit 0
`,
      );
      await fixture.waitForTranscript(tabId, "READY");

      const payload = Array.from({ length: frames }, (_, index) =>
        `FRAME-${index.toString().padStart(4, "0")}-${"x".repeat(52)}`,
      ).join("\n");
      await fixture.write(tabId, `${payload}\n`);
      await fixture.waitForTranscript(tabId, "FRAME-0999");

      const transcript = fixture.transcript(tabId);
      let cursor = 0;
      for (let index = 0; index < frames; index += 1) {
        const marker = `FRAME-${index.toString().padStart(4, "0")}`;
        const offset = transcript.indexOf(marker, cursor);
        if (offset < cursor) {
          throw new Error(`missing ${marker} after transcript offset ${cursor}`);
        }
        cursor = offset + marker.length;
      }
      const exit = await fixture.waitForExit(tabId);
      expect(exit.code).toBe(0);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("bounds full-path PTY output while renderer ack is withheld, then resumes after ack", async () => {
    const fixture = await PtyAgentFixture.create(binPath);
    try {
      const tabId = "backpressure";
      await fixture.spawnScript(
        tabId,
        `
yes A | head -c 250000
sleep 5
`,
      );

      await fixture.waitForRawBytesAtLeast(tabId, HIGH_WATERMARK_BYTES);
      const withoutAck = fixture.rawBytes(tabId);
      expect(withoutAck).toBeLessThanOrEqual(HIGH_WATERMARK_BYTES + MAX_CHUNK_SIZE);

      await sleep(250);
      expect(fixture.rawBytes(tabId)).toBe(withoutAck);

      await fixture.ack(tabId, withoutAck - LOW_WATERMARK_BYTES);
      await fixture.waitForRawBytesGreaterThan(tabId, withoutAck);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("delivers raw Ctrl-C through the PTY line discipline and reports a SIGINT exit", async () => {
    const fixture = await PtyAgentFixture.create(binPath);
    try {
      const tabId = "ctrl-c";
      const rawExit = fixture.waitForRawExit(tabId);
      await fixture.spawnScript(
        tabId,
        `
stty -echo
echo READY
exec cat
`,
      );
      await fixture.waitForTranscript(tabId, "READY");

      await fixture.write(tabId, String.fromCharCode(0x03));

      const hostExit = await fixture.waitForExit(tabId);
      const agentExit = await rawExit;
      expect(hostExit.code).toBeNull();
      expect(agentExit).toMatchObject({ workspaceId: WORKSPACE_ID, tabId, code: null });
      expect((agentExit as { signal?: string }).signal).toBe("SIGINT");
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("resizes the PTY so the child observes the new stty size", async () => {
    const fixture = await PtyAgentFixture.create(binPath);
    try {
      const tabId = "resize";
      await fixture.spawnScript(
        tabId,
        `
stty -echo
echo READY
trap 'printf "SIZE "; stty size' WINCH
while :; do sleep 1; done
`,
      );
      await fixture.waitForTranscript(tabId, "READY");

      await fixture.resize(tabId, 120, 40);
      await fixture.waitForTranscript(tabId, "SIZE 40 120");
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("reports child exit code 42", async () => {
    const fixture = await PtyAgentFixture.create(binPath);
    try {
      const tabId = "exit-42";
      await fixture.spawnScript(
        tabId,
        `
exit 42
`,
      );

      const exit = await fixture.waitForExit(tabId);
      expect(exit.code).toBe(42);
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("leaves no orphan processes after dispose", async () => {
    const fixture = await PtyAgentFixture.create(binPath);
    const tabId = "zombie-check";
    await fixture.spawnScript(
      tabId,
      `
stty -echo
echo READY
exec cat
`,
    );
    await fixture.waitForTranscript(tabId, "READY");

    await fixture.dispose();

    // pgrep exit code 1 means no matching processes — the agent binary is gone.
    const result = spawnSync("pgrep", ["-f", binPath]);
    expect(result.status).toBe(1);
  }, 30_000);
});

interface PtyExitEvent {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly code: number | null;
}

interface CapturedSession {
  readonly chunks: string[];
  readonly exits: PtyExitEvent[];
}

/**
 * PtyAgentFixture drives the production TS AgentPtyHost against a real Go
 * agent process so tests cover main host decoding, ReconnectingProcessChannel,
 * NdjsonPipe, Go PTY service, and a child shell in one path.
 */
class PtyAgentFixture {
  private readonly sessions = new Map<string, CapturedSession>();
  private readonly activeTabs = new Set<string>();
  private disposed = false;

  private constructor(
    private readonly root: string,
    private readonly channel: AgentChannel,
    private readonly host: PtyHostHandle,
  ) {
    host.on("data", (payload) => {
      const event = payload as { workspaceId: string; tabId: string; chunk: string };
      if (event.workspaceId !== WORKSPACE_ID) return;
      this.session(event.tabId).chunks.push(event.chunk);
    });
    host.on("exit", (payload) => {
      const event = payload as PtyExitEvent;
      if (event.workspaceId !== WORKSPACE_ID) return;
      this.session(event.tabId).exits.push(event);
      this.activeTabs.delete(event.tabId);
    });
  }

  /**
   * Creates a temporary workspace and a local agent channel for one test.
   */
  static async create(binaryPath: string): Promise<PtyAgentFixture> {
    const root = await fs.mkdtemp(path.join(tmpdir(), "nexus-pty-root-"));
    const channel = createLocalChannel({
      binaryPath,
      rootPath: root,
      requestTimeoutMs: 10_000,
      reconnect: { initialDelayMs: 25, maxDelayMs: 50 },
    });
    const host = startAgentPtyHost({
      getAgentChannel: async () => channel,
      tryGetAgentChannel: async () => channel,
    });
    await channel.ready;
    return new PtyAgentFixture(root, channel, host);
  }

  /**
   * Writes an executable shell script and asks the real agent PTY service to
   * run that script as the session shell.
   */
  async spawnScript(tabId: string, body: string): Promise<void> {
    const shell = await this.writeExecutableScript(tabId, body);
    const result = (await this.host.call("spawn", {
      workspaceId: WORKSPACE_ID,
      tabId,
      cwd: this.root,
      shell,
      cols: 80,
      rows: 24,
      env: { TERM: "xterm-256color" },
    })) as { pid?: unknown };
    expect(typeof result.pid).toBe("number");
    this.activeTabs.add(tabId);
  }

  /**
   * Sends renderer input bytes to the child PTY.
   */
  async write(tabId: string, data: string): Promise<void> {
    await this.host.call("write", { workspaceId: WORKSPACE_ID, tabId, data });
  }

  /**
   * Sends renderer byte-credit for previously delivered terminal output.
   */
  async ack(tabId: string, bytesConsumed: number): Promise<void> {
    await this.host.call("ack", { workspaceId: WORKSPACE_ID, tabId, bytesConsumed });
  }

  /**
   * Updates the PTY geometry visible to the child process.
   */
  async resize(tabId: string, cols: number, rows: number): Promise<void> {
    await this.host.call("resize", { workspaceId: WORKSPACE_ID, tabId, cols, rows });
  }

  /**
   * Returns all decoded output captured for one tab.
   */
  transcript(tabId: string): string {
    return this.session(tabId).chunks.join("");
  }

  /**
   * Returns the UTF-8 byte count for captured output. Test payloads are ASCII,
   * so this is also the raw PTY byte count after base64 decoding.
   */
  rawBytes(tabId: string): number {
    return Buffer.byteLength(this.transcript(tabId), "utf8");
  }

  /**
   * Waits until decoded terminal output contains the expected marker.
   */
  waitForTranscript(tabId: string, marker: string, timeoutMs = 5_000): Promise<void> {
    return waitUntil(
      () => this.transcript(tabId).includes(marker),
      () => `timed out waiting for ${JSON.stringify(marker)} in ${tabId}:\n${this.transcript(tabId)}`,
      timeoutMs,
    );
  }

  /**
   * Waits until at least n PTY output bytes have reached the main host.
   */
  waitForRawBytesAtLeast(tabId: string, n: number, timeoutMs = 5_000): Promise<void> {
    return waitUntil(
      () => this.rawBytes(tabId) >= n,
      () => `timed out waiting for >= ${n} raw bytes in ${tabId}; got ${this.rawBytes(tabId)}`,
      timeoutMs,
    );
  }

  /**
   * Waits until the captured output byte count exceeds n.
   */
  waitForRawBytesGreaterThan(tabId: string, n: number, timeoutMs = 5_000): Promise<void> {
    return waitUntil(
      () => this.rawBytes(tabId) > n,
      () => `timed out waiting for > ${n} raw bytes in ${tabId}; got ${this.rawBytes(tabId)}`,
      timeoutMs,
    );
  }

  /**
   * Waits for the main host's PTY exit event for one tab.
   */
  async waitForExit(tabId: string, timeoutMs = 5_000): Promise<PtyExitEvent> {
    await waitUntil(
      () => this.session(tabId).exits.length > 0,
      () => `timed out waiting for host pty.exit in ${tabId}`,
      timeoutMs,
    );
    return this.session(tabId).exits[0];
  }

  /**
   * Waits for the raw agent `pty.exit` payload before AgentPtyHost narrows it.
   */
  waitForRawExit(tabId: string, timeoutMs = 5_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out waiting for raw pty.exit in ${tabId}`));
      }, timeoutMs);
      const unsubscribe = this.channel.on("pty.exit", (payload) => {
        const event = payload as { workspaceId?: unknown; tabId?: unknown };
        if (event.workspaceId !== WORKSPACE_ID || event.tabId !== tabId) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(payload);
      });
    });
  }

  /**
   * Kills remaining child sessions, then tears down the main host, agent, and
   * temporary workspace.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const tabId of Array.from(this.activeTabs)) {
      await this.host.call("kill", { workspaceId: WORKSPACE_ID, tabId }).catch(() => {});
    }
    this.host.dispose();
    this.channel.dispose();
    await sleep(150);
    await fs.rm(this.root, { recursive: true, force: true });
  }

  /**
   * Returns the mutable capture record for one tab.
   */
  private session(tabId: string): CapturedSession {
    let session = this.sessions.get(tabId);
    if (!session) {
      session = { chunks: [], exits: [] };
      this.sessions.set(tabId, session);
    }
    return session;
  }

  /**
   * Creates an executable POSIX shell script in the temporary workspace.
   */
  private async writeExecutableScript(tabId: string, body: string): Promise<string> {
    const scriptPath = path.join(this.root, `${tabId}.sh`);
    await fs.writeFile(scriptPath, `#!/bin/sh\n${body.trimStart()}`, "utf8");
    await fs.chmod(scriptPath, 0o755);
    return scriptPath;
  }
}

/**
 * Polls a condition until it passes or raises the caller's diagnostic message.
 */
async function waitUntil(
  predicate: () => boolean,
  message: () => string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message());
}

/**
 * Promise wrapper around setTimeout for bounded async polling and cleanup gaps.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
