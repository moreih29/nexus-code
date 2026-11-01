/**
 * Opens an authenticated ssh2 connection the way `ssh` would.
 *
 * The host's settings come from `ssh -G` (config.ts): its real name and port,
 * user, keys, agent, jump hosts or proxy command, and known_hosts files. The
 * host key is checked against known_hosts (known-hosts.ts); an unknown one is
 * shown to the user to trust, as OpenSSH asks, and is then recorded.
 *
 * Authentication follows PreferredAuthentications: the agent's keys and the
 * identity files (asking for an encrypted key's passphrase), then
 * keyboard-interactive (each prompt, such as a one-time code, goes to the
 * user), then the password. A password the server rejects is asked again,
 * twice, as sshd allows.
 *
 * With ForwardAgent each session asks the host to forward the agent.
 *
 * Without a prompt handler nothing is asked: an unknown host key fails as
 * BatchMode does, and encrypted keys and passwords are skipped.
 *
 * Failures are SshErrors: ssh.connect-failed when the host cannot be reached
 * or its key is refused, ssh.auth-failed when no method authenticates.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { Duplex } from "node:stream";
import type {
  AnyAuthMethod,
  AuthenticationType,
  AuthHandlerMiddleware,
  Client,
  ConnectConfig,
  KeyboardInteractiveCallback,
  ParsedKey,
  Prompt,
} from "ssh2";
import type { SshAuthPrompt } from "../../../../../shared/ssh/auth-prompt";
import type { SshErrorCode } from "../../../../../shared/ssh/errors";
import { createSshError } from "../../pipe";
import type { SshAuthPromptHandler } from "../auth-pty";
import { resolveSshHostConfig, type SshHostConfig, type SshTarget } from "./config";
import {
  addHostKey,
  checkHostKey,
  hostKeyFingerprint,
  hostKeyType,
  knownHostName,
} from "./known-hosts";

/** As auth-pty: how long a connection may take, not counting time spent on prompts. */
const CONNECT_TIMEOUT_MS = 30_000;
/** As OpenSSH's ServerAliveInterval=5 / ServerAliveCountMax=3 on our masters. */
const KEEPALIVE_INTERVAL_MS = 5_000;
const KEEPALIVE_COUNT_MAX = 3;
const PASSWORD_ATTEMPTS = 3;
const PASSPHRASE_ATTEMPTS = 3;

export interface ConnectSsh2Dependencies {
  readonly resolveConfig?: (target: SshTarget) => Promise<SshHostConfig>;
  readonly connectTimeoutMs?: number;
}

/** An open connection and the jump hosts and proxy process it runs through. */
export interface Ssh2Connection {
  readonly client: Client;
  readonly config: SshHostConfig;
  /** Ends the connection and everything it runs through. */
  end(): void;
}

let promptSequence = 0;

export async function connectSsh2(
  target: SshTarget,
  promptHandler: SshAuthPromptHandler | null,
  dependencies: ConnectSsh2Dependencies = {},
): Promise<Ssh2Connection> {
  const resolveConfig = dependencies.resolveConfig ?? ((t: SshTarget) => resolveSshHostConfig(t));
  const config = await resolveConfig(target);
  const hops: Ssh2Connection[] = [];
  let proxy: ChildProcess | null = null;
  const endAll = (): void => {
    proxy?.kill();
    for (const hop of [...hops].reverse()) hop.end();
  };
  try {
    let sock: Duplex | undefined;
    if (config.proxyJump.length > 0) {
      // Each jump host connects through the one before it, as ProxyJump does.
      let via: Ssh2Connection | null = null;
      for (const jump of config.proxyJump) {
        const hop = await connectThrough(parseJumpHost(jump), via, promptHandler, dependencies);
        hops.push(hop);
        via = hop;
      }
      sock = await forwardTo(via as Ssh2Connection, config.hostname, config.port);
    } else if (config.proxyCommand !== null) {
      proxy = spawnProxyCommand(config);
      sock = proxySocket(proxy);
    }
    const client = await authenticate(config, sock, promptHandler, dependencies);
    client.on("close", endAll);
    return {
      client,
      config,
      end: () => {
        client.end();
        endAll();
      },
    };
  } catch (error) {
    endAll();
    throw error;
  }
}

async function connectThrough(
  target: SshTarget,
  via: Ssh2Connection | null,
  promptHandler: SshAuthPromptHandler | null,
  dependencies: ConnectSsh2Dependencies,
): Promise<Ssh2Connection> {
  if (via === null) return connectSsh2(target, promptHandler, dependencies);
  const resolveConfig = dependencies.resolveConfig ?? ((t: SshTarget) => resolveSshHostConfig(t));
  // A jump host's own ProxyJump is not followed; it is reached through the one before it.
  const config = { ...(await resolveConfig(target)), proxyJump: [], proxyCommand: null };
  const sock = await forwardTo(via, config.hostname, config.port);
  const client = await authenticate(config, sock, promptHandler, dependencies);
  return { client, config, end: () => client.end() };
}

/** Parses a ProxyJump entry, `[user@]host[:port]`. */
export function parseJumpHost(spec: string): SshTarget {
  const at = spec.lastIndexOf("@");
  const user = at >= 0 ? spec.slice(0, at) : undefined;
  let host = at >= 0 ? spec.slice(at + 1) : spec;
  let port: number | undefined;
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(host);
  const plain = /^([^:]+):(\d+)$/.exec(host);
  if (bracketed) {
    host = bracketed[1];
    port = Number(bracketed[2]);
  } else if (plain) {
    host = plain[1];
    port = Number(plain[2]);
  }
  return { host, user: user || undefined, port };
}

function forwardTo(via: Ssh2Connection, hostname: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    via.client.forwardOut("127.0.0.1", 0, hostname, port, (error, stream) => {
      if (error) {
        reject(createSshError("ssh.connect-failed", error));
        return;
      }
      resolve(stream);
    });
  });
}

/** Starts ProxyCommand through the shell, with its `%` tokens expanded. */
function spawnProxyCommand(config: SshHostConfig): ChildProcess {
  const command = (config.proxyCommand ?? "").replace(/%([%hpnr])/g, (_match, token: string) => {
    switch (token) {
      case "h":
        return config.hostname;
      case "p":
        return String(config.port);
      case "n":
        return config.host;
      case "r":
        return config.user;
      default:
        return "%";
    }
  });
  return spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
}

/** The proxy process's stdio as the stream ssh2 talks over. */
function proxySocket(proxy: ChildProcess): Duplex {
  const stdin = proxy.stdin;
  const stdout = proxy.stdout;
  if (!stdin || !stdout) throw createSshError("ssh.connect-failed", "proxy command has no stdio");
  const sock = new Duplex({
    read() {
      stdout.resume();
    },
    write(chunk, _encoding, callback) {
      stdin.write(chunk, callback);
    },
    final(callback) {
      stdin.end(callback);
    },
  });
  stdout.on("data", (chunk: Buffer) => {
    if (!sock.push(chunk)) stdout.pause();
  });
  stdout.on("end", () => sock.push(null));
  proxy.on("error", (error) => sock.destroy(error));
  return sock;
}

/** Connects and authenticates one hop. */
function authenticate(
  config: SshHostConfig,
  sock: Duplex | undefined,
  promptHandler: SshAuthPromptHandler | null,
  dependencies: ConnectSsh2Dependencies,
): Promise<Client> {
  // ssh2 is loaded on first use: only the Windows SSH path needs it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client: ClientClass } = require("ssh2") as typeof import("ssh2");
  const client = new ClientClass();
  const timeoutMs = dependencies.connectTimeoutMs ?? config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  return new Promise<Client>((resolve, reject) => {
    let settled = false;
    let hostKeyRefused: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let promptsOpen = 0;

    const armTimer = (): void => {
      disarmTimer();
      timer = setTimeout(() => fail("ssh.connect-failed", "connection timed out"), timeoutMs);
      timer.unref?.();
    };
    const disarmTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    /** Asks the user, with the connection timeout paused meanwhile. */
    const ask = async (prompt: SshAuthPrompt) => {
      if (promptHandler === null) throw new Error("no prompt handler");
      promptsOpen += 1;
      disarmTimer();
      try {
        return await promptHandler(prompt);
      } finally {
        promptsOpen -= 1;
        if (promptsOpen === 0 && !settled) armTimer();
      }
    };
    // The error is made only for a connection still opening: making an
    // SshError logs it.
    const fail = (code: SshErrorCode, cause: unknown): void => {
      if (settled) return;
      settled = true;
      disarmTimer();
      client.end();
      reject(createSshError(code, cause));
    };

    client.once("ready", () => {
      if (settled) return;
      settled = true;
      disarmTimer();
      resolve(client);
    });
    // Kept for the connection's life: an error with no listener would throw.
    client.on("error", (error: Error & { level?: string }) => {
      if (hostKeyRefused !== null) fail("ssh.connect-failed", hostKeyRefused);
      else if (error.level === "client-authentication") fail("ssh.auth-failed", error);
      else fail("ssh.connect-failed", error);
    });
    client.once("close", () => fail("ssh.connect-failed", "connection closed"));

    const connectConfig: ConnectConfig = {
      host: config.hostname,
      port: config.port,
      username: config.user,
      sock,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      // The timer above bounds the connection instead: it pauses for prompts.
      readyTimeout: 2 ** 31 - 1,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        verifyHostKey(config, key, ask, promptHandler !== null).then(
          (refusal) => {
            hostKeyRefused = refusal;
            verify(refusal === null);
          },
          (error: unknown) => {
            hostKeyRefused = error instanceof Error ? error.message : String(error);
            verify(false);
          },
        );
      },
      authHandler: createAuthHandler(config, ask, promptHandler !== null),
      // ForwardAgent: each session asks the host to forward the agent, so
      // the workspace's terminals there sign with the user's keys, as for a
      // git push over ssh.
      ...(config.forwardAgent !== null ? { agent: config.forwardAgent, agentForward: true } : {}),
    };
    armTimer();
    client.connect(connectConfig);
  });
}

/** Resolves null when the host key is trusted, else why it is refused. */
async function verifyHostKey(
  config: SshHostConfig,
  key: Buffer,
  ask: (prompt: SshAuthPrompt) => Promise<unknown>,
  canAsk: boolean,
): Promise<string | null> {
  const name = knownHostName(config.hostKeyAlias ?? config.hostname, config.port);
  const files = [...config.knownHostsFiles, ...config.globalKnownHostsFiles];
  const status = await checkHostKey(files, name, key);
  if (status.kind === "known") return null;
  if (status.kind === "revoked") {
    return `Host key verification failed: the key for ${name} is revoked (${status.file}:${status.line})`;
  }
  if (status.kind === "changed") {
    return `Host key verification failed: REMOTE HOST IDENTIFICATION HAS CHANGED for ${name} (${status.file}:${status.line})`;
  }
  const strict = config.strictHostKeyChecking;
  if (strict === "yes") return `Host key verification failed: no key for ${name} is known`;
  if (strict === "ask") {
    if (!canAsk) return `Host key verification failed: no key for ${name} is known`;
    const fingerprint = hostKeyFingerprint(key);
    const type = hostKeyType(key);
    try {
      await ask({
        kind: "host-key",
        promptId: nextPromptId("host-key"),
        host: config.host,
        port: config.port === 22 ? undefined : config.port,
        username: config.user,
        keyType: type,
        fingerprint,
        message: `The authenticity of host '${name}' can't be established.\n${type} key fingerprint is ${fingerprint}.`,
      });
    } catch {
      return "Host key verification failed: the key was not trusted";
    }
  }
  const file = config.knownHostsFiles[0];
  if (file) await addHostKey(file, name, key, config.hashKnownHosts).catch(() => undefined);
  return null;
}

type AuthAttempt =
  | { readonly type: "none"; readonly username: string }
  | { readonly type: "agent"; readonly username: string; readonly agent: string }
  | { readonly type: "publickey"; readonly username: string; readonly key: ParsedKey }
  | { readonly type: "password"; readonly username: string; readonly password: string }
  | {
      readonly type: "keyboard-interactive";
      readonly username: string;
      readonly prompt: (
        name: string,
        instructions: string,
        lang: string,
        prompts: Prompt[],
        finish: KeyboardInteractiveCallback,
      ) => void;
    };

/** Which server-side method an attempt uses. */
function methodOf(attempt: AuthAttempt): AuthenticationType {
  return attempt.type === "agent" ? "publickey" : attempt.type;
}

function createAuthHandler(
  config: SshHostConfig,
  ask: (prompt: SshAuthPrompt) => Promise<{ kind: string; value?: string }>,
  canAsk: boolean,
) {
  let methodsLeft: readonly string[] | null = null;
  // A prompt the user cancels ends authentication, as closing OpenSSH's would.
  let cancelled = false;
  const askOrCancel: typeof ask = async (prompt) => {
    try {
      return await ask(prompt);
    } catch (error) {
      cancelled = true;
      throw error;
    }
  };
  const attempts = authAttempts(config, askOrCancel, canAsk, () => methodsLeft);
  // ssh2 takes false to stop authenticating, though its types leave it out.
  const stop = false as unknown as AnyAuthMethod;
  const handler: AuthHandlerMiddleware = (left, _partialSuccess, callback) => {
    if (left !== null) methodsLeft = left;
    const pull = async (): Promise<AuthAttempt | false> => {
      for (;;) {
        if (cancelled) return false;
        const next = await attempts.next();
        if (next.done || cancelled) return false;
        const allowed = methodsLeft === null || methodsLeft.includes(methodOf(next.value));
        if (allowed) return next.value;
      }
    };
    pull().then(
      (next) => callback(next === false ? stop : next),
      () => callback(stop),
    );
  };
  return handler;
}

/** The authentication attempts to make, in order, built as the server asks for them. */
async function* authAttempts(
  config: SshHostConfig,
  ask: (prompt: SshAuthPrompt) => Promise<{ kind: string; value?: string }>,
  canAsk: boolean,
  methodsLeft: () => readonly string[] | null,
): AsyncGenerator<AuthAttempt> {
  const username = config.user;
  const offered = (method: string): boolean => methodsLeft()?.includes(method) ?? true;
  yield { type: "none", username };

  for (const method of config.preferredAuthentications) {
    if (!offered(method)) continue;
    if (method === "publickey") {
      if (config.identityAgent !== null && !config.identitiesOnly) {
        if (await agentReachable(config.identityAgent)) {
          yield { type: "agent", username, agent: config.identityAgent };
        }
      }
      // Unencrypted keys first, so a passphrase is asked only when they fail.
      const encrypted: Buffer[] = [];
      const encryptedFiles: string[] = [];
      for (const file of config.identityFiles) {
        const data = await fs.readFile(file).catch(() => null);
        if (data === null) continue;
        const key = parsePrivateKey(data);
        if (key === "encrypted") {
          encrypted.push(data);
          encryptedFiles.push(file);
        } else if (key !== null) {
          yield { type: "publickey", username, key };
        }
      }
      if (!canAsk) continue;
      for (let index = 0; index < encrypted.length; index += 1) {
        if (!offered("publickey")) break;
        const key = await unlockKey(encrypted[index], encryptedFiles[index], config, ask);
        if (key !== null) yield { type: "publickey", username, key };
      }
    } else if (method === "keyboard-interactive" && canAsk) {
      for (let round = 0; round < PASSWORD_ATTEMPTS && offered(method); round += 1) {
        yield {
          type: "keyboard-interactive",
          username,
          prompt: (_name, _instructions, _lang, prompts, finish) => {
            answerPrompts(prompts, round > 0, config, ask).then(finish, () => finish([]));
          },
        };
      }
    } else if (method === "password" && canAsk) {
      for (let round = 0; round < PASSWORD_ATTEMPTS && offered(method); round += 1) {
        const response = await ask({
          kind: "password",
          promptId: nextPromptId("password"),
          host: config.host,
          port: config.port === 22 ? undefined : config.port,
          username,
          prompt: `${username}@${config.hostname}'s password:`,
          field: "password",
          retry: round > 0 || undefined,
        });
        yield { type: "password", username, password: response.value ?? "" };
      }
    }
  }
}

async function answerPrompts(
  prompts: Prompt[],
  retry: boolean,
  config: SshHostConfig,
  ask: (prompt: SshAuthPrompt) => Promise<{ kind: string; value?: string }>,
): Promise<string[]> {
  const answers: string[] = [];
  for (const prompt of prompts) {
    const response = await ask({
      kind: "password",
      promptId: nextPromptId("password"),
      host: config.host,
      port: config.port === 22 ? undefined : config.port,
      username: config.user,
      prompt: prompt.prompt.trim() || "Password:",
      field: "password",
      retry: (retry && answers.length === 0) || undefined,
    });
    answers.push(response.value ?? "");
  }
  return answers;
}

async function unlockKey(
  data: Buffer,
  file: string,
  config: SshHostConfig,
  ask: (prompt: SshAuthPrompt) => Promise<{ kind: string; value?: string }>,
): Promise<ParsedKey | null> {
  for (let round = 0; round < PASSPHRASE_ATTEMPTS; round += 1) {
    const response = await ask({
      kind: "password",
      promptId: nextPromptId("passphrase"),
      host: config.host,
      port: config.port === 22 ? undefined : config.port,
      username: config.user,
      prompt: `Enter passphrase for key '${file}':`,
      field: "passphrase",
      retry: round > 0 || undefined,
    });
    const key = parsePrivateKey(data, response.value ?? "");
    if (key !== null && key !== "encrypted") return key;
  }
  return null;
}

/** Parses a private key; "encrypted" when it needs a (different) passphrase. */
function parsePrivateKey(data: Buffer, passphrase?: string): ParsedKey | "encrypted" | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { utils } = require("ssh2") as typeof import("ssh2");
  const parsed = utils.parseKey(data, passphrase);
  if (parsed instanceof Error) {
    return /encrypted|passphrase|decrypt/i.test(parsed.message) ? "encrypted" : null;
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  return key ?? null;
}

/** Whether the agent socket or pipe takes connections. */
function agentReachable(agent: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(agent);
    const done = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

function nextPromptId(kind: string): string {
  promptSequence += 1;
  return `ssh-auth:ssh2:${promptSequence}:${kind}`;
}
