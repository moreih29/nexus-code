/**
 * The ssh2 client against an in-process ssh2 server: host-key trust, the
 * authentication prompts, and commands sharing one connection as they would
 * a ControlMaster.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Connection, Server, utils } from "ssh2";
import { buildSshArgs } from "../../../../src/main/infra/agent/ssh/master";
import type { SshHostConfig } from "../../../../src/main/infra/agent/ssh/ssh2/config";
import { connectSsh2 } from "../../../../src/main/infra/agent/ssh/ssh2/connect";
import {
  authenticateSsh2Master,
  spawnSsh2Process,
} from "../../../../src/main/infra/agent/ssh/ssh2/index";
import { addHostKey, knownHostName } from "../../../../src/main/infra/agent/ssh/ssh2/known-hosts";
import type { SshAuthPrompt, SshAuthResponse } from "../../../../src/shared/ssh/auth-prompt";

// ssh2 runs its handshake crypto in JavaScript: on a loaded runner, a test
// that connects twice takes longer than the 5s default.
setDefaultTimeout(30_000);

/**
 * An ed25519 key pair ssh2 can read back. About one pair in 256 has a public
 * key that starts with a zero byte, which ssh2's generator drops: it then
 * writes a 31-byte key that it rejects as malformed.
 */
function generateHostKey(): ReturnType<typeof utils.generateKeyPairSync> {
  for (;;) {
    const pair = utils.generateKeyPairSync("ed25519");
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
}

const HOST_KEY = generateHostKey();
const OTHER_HOST_KEY = generateHostKey();

interface TestServer {
  readonly port: number;
  /** Connections that authenticated. */
  readonly sessions: () => number;
  dropAll(): void;
  close(): Promise<void>;
}

/** Serves `password` (or a one-time code) and a few test commands. */
function startServer(auth: { password?: string; code?: string }): Promise<TestServer> {
  const clients = new Set<Connection>();
  let sessions = 0;
  const server = new Server({ hostKeys: [HOST_KEY.private] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && auth.password !== undefined) {
        if (ctx.password === auth.password) return ctx.accept();
      } else if (ctx.method === "keyboard-interactive" && auth.code !== undefined) {
        ctx.prompt([{ prompt: "Verification code: ", echo: false }], (answers) => {
          if (answers[0] === auth.code) ctx.accept();
          else ctx.reject(["keyboard-interactive"]);
        });
        return;
      }
      ctx.reject(auth.code !== undefined ? ["keyboard-interactive"] : ["password"]);
    });
    client.on("ready", () => {
      sessions += 1;
      client.on("session", (acceptSession) => {
        acceptSession().on("exec", (accept, _reject, info) => {
          const stream = accept();
          const [verb, arg = ""] = info.command.split(":");
          if (verb === "echo") {
            stream.write(arg);
            stream.exit(0);
            stream.end();
          } else if (verb === "exit") {
            stream.stderr.write(`exiting ${arg}\n`);
            stream.exit(Number(arg));
            stream.end();
          } else if (verb === "cat") {
            stream.on("data", (chunk: Buffer) => stream.write(chunk));
            stream.on("end", () => {
              stream.exit(0);
              stream.end();
            });
          } else {
            stream.exit(127);
            stream.end();
          }
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        sessions: () => sessions,
        dropAll: () => {
          for (const client of clients) client.end();
        },
        close: async () => {
          for (const client of clients) client.end();
          // Not waited for: under load, Bun can keep an accepted socket the
          // client has closed neither open nor destroyed, and close() would
          // wait on it for good.
          server.close();
        },
      });
    });
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(auth: { password?: string; code?: string }) {
  const server = await startServer(auth);
  cleanups.push(() => server.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ssh2-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const knownHosts = path.join(dir, "known_hosts");
  const config: SshHostConfig = {
    host: "test-host",
    hostname: "127.0.0.1",
    port: server.port,
    user: "alice",
    identityFiles: [],
    identitiesOnly: false,
    identityAgent: null,
    proxyJump: [],
    proxyCommand: null,
    connectTimeoutMs: null,
    hostKeyAlias: null,
    knownHostsFiles: [knownHosts],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: "ask",
    hashKnownHosts: false,
    preferredAuthentications: ["publickey", "keyboard-interactive", "password"],
  };
  const prompts: SshAuthPrompt[] = [];
  const answers: string[] = [];
  const handler = async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
    prompts.push(prompt);
    if (prompt.kind === "host-key")
      return { kind: "host-key", promptId: prompt.promptId, trust: "yes" };
    return { kind: "password", promptId: prompt.promptId, value: answers.shift() ?? "" };
  };
  const dependencies = { resolveConfig: async () => config };
  const target = { host: "test-host", user: "alice", port: server.port };
  return { server, knownHosts, prompts, answers, handler, dependencies, target };
}

/** Runs `ssh … command` on the control path; resolves its output and exit code. */
function run(controlPath: string, command: string, input?: string) {
  const child = spawnSsh2Process(
    "ssh",
    buildSshArgs({ host: "test-host", user: "alice", controlPath, remoteCommand: command }),
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  if (input !== undefined) child.stdin.end(input);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code: number | null) => resolve({ code, stdout, stderr }));
  });
}

describe("connectSsh2", () => {
  it("records a host key the user trusts and asks for it only once", async () => {
    const t = await setup({ password: "pw" });
    t.answers.push("pw", "pw");

    const first = await connectSsh2(t.target, t.handler, t.dependencies);
    first.end();
    const second = await connectSsh2(t.target, t.handler, t.dependencies);
    second.end();

    expect(t.prompts.map((p) => p.kind)).toEqual(["host-key", "password", "password"]);
    expect(t.prompts[0]).toMatchObject({ host: "test-host", keyType: "ssh-ed25519" });
    expect(fs.readFileSync(t.knownHosts, "utf8")).toContain(
      knownHostName("127.0.0.1", t.server.port),
    );
  });

  it("asks for the password again after a wrong one", async () => {
    const t = await setup({ password: "pw" });
    t.answers.push("wrong", "pw");

    const connection = await connectSsh2(t.target, t.handler, t.dependencies);
    connection.end();

    const passwords = t.prompts.filter((p) => p.kind === "password");
    expect(passwords.map((p) => p.retry)).toEqual([undefined, true]);
    expect(passwords[0]).toMatchObject({
      prompt: `alice@127.0.0.1's password:`,
      field: "password",
    });
  });

  it("passes keyboard-interactive prompts such as a one-time code to the user", async () => {
    const t = await setup({ code: "123456" });
    t.answers.push("123456");

    const connection = await connectSsh2(t.target, t.handler, t.dependencies);
    connection.end();

    expect(t.prompts.filter((p) => p.kind === "password")).toEqual([
      expect.objectContaining({ prompt: "Verification code:" }),
    ]);
  });

  it("fails as an authentication failure when the user cancels", async () => {
    const t = await setup({ password: "pw" });
    const cancelling = async (prompt: SshAuthPrompt): Promise<SshAuthResponse> => {
      if (prompt.kind === "host-key")
        return { kind: "host-key", promptId: prompt.promptId, trust: "yes" };
      throw new Error("cancelled");
    };

    await expect(connectSsh2(t.target, cancelling, t.dependencies)).rejects.toMatchObject({
      code: "ssh.auth-failed",
    });
  });

  it("refuses a changed host key without asking", async () => {
    const t = await setup({ password: "pw" });
    const other = utils.parseKey(OTHER_HOST_KEY.public);
    if (other instanceof Error) throw other;
    await addHostKey(
      t.knownHosts,
      knownHostName("127.0.0.1", t.server.port),
      other.getPublicSSH(),
      false,
    );

    await expect(connectSsh2(t.target, t.handler, t.dependencies)).rejects.toMatchObject({
      code: "ssh.connect-failed",
    });
    expect(t.prompts).toEqual([]);
  });

  it("fails an unknown host key without a prompt handler, as BatchMode does", async () => {
    const t = await setup({ password: "pw" });
    await expect(connectSsh2(t.target, null, t.dependencies)).rejects.toMatchObject({
      code: "ssh.connect-failed",
    });
  });
});

describe("ssh2 control master", () => {
  it("runs every command on the one connection", async () => {
    const t = await setup({ password: "pw" });
    t.answers.push("pw");
    const master = await authenticateSsh2Master(t.target, t.handler, t.dependencies);
    cleanups.push(() => master.dispose());

    expect(await run(master.controlPath, "echo:hello")).toEqual({
      code: 0,
      stdout: "hello",
      stderr: "",
    });
    expect(await run(master.controlPath, "exit:3")).toEqual({
      code: 3,
      stdout: "",
      stderr: "exiting 3\n",
    });
    expect((await run(master.controlPath, "cat", "piped input")).stdout).toBe("piped input");
    expect(t.server.sessions()).toBe(1);
    expect(t.prompts.map((p) => p.kind)).toEqual(["host-key", "password"]);
  });

  it("opens the connection again once it drops", async () => {
    const t = await setup({ password: "pw" });
    t.answers.push("pw", "pw");
    const master = await authenticateSsh2Master(t.target, t.handler, t.dependencies);
    cleanups.push(() => master.dispose());
    expect((await run(master.controlPath, "echo:one")).stdout).toBe("one");

    t.server.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await run(master.controlPath, "echo:two")).stdout).toBe("two");
    expect(t.server.sessions()).toBe(2);
  });

  it("reports a failed connection as ssh does, exit 255 with the reason on stderr", async () => {
    const t = await setup({ password: "pw" });
    t.answers.push("pw", "wrong", "wrong", "wrong");
    const master = await authenticateSsh2Master(t.target, t.handler, t.dependencies);
    cleanups.push(() => master.dispose());
    t.server.dropAll();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = await run(master.controlPath, "echo:never");
    expect(result.code).toBe(255);
    expect(result.stderr).toMatch(/Permission denied \(/);
  });
});
