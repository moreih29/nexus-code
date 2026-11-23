import type { IPty } from "node-pty";
import type { SshAuthPrompt, SshAuthResponse } from "../../../../shared/ssh/auth-prompt";
import type { SshErrorCode } from "../../../../shared/ssh/errors";
import { createSshError } from "../pipe";
import { AuthCancelledError } from "./auth";
import {
  buildSshControlMasterArgs,
  createSshControlMaster,
  type SpawnSshProcess,
  type SshControlMaster,
  type SshMasterOptions,
} from "./master";
import { authenticateSsh2Master, usesSsh2Client } from "./ssh2";

const PASSWORD_PROMPT_PATTERN = /([^\r\n]*?(?:password|passphrase)\s*(?:for [^:]+)?\s*:)\s*$/i;
const HOST_KEY_PROMPT_PATTERN =
  /Are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\?/i;
const FINGERPRINT_PATTERN = /([A-Z0-9]+) key fingerprint is:? (SHA256:[^\s.]+)/i;
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;

export type SshAuthPromptHandler = (
  prompt: SshAuthPrompt,
  signal?: AbortSignal,
) => Promise<SshAuthResponse>;
export type SpawnPty = (
  command: string,
  args: string[],
  options: { name: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
) => IPty;

export interface AuthenticateSshControlMasterDependencies {
  readonly spawnPty?: SpawnPty;
  readonly spawn?: SpawnSshProcess;
  readonly unlink?: (path: string) => void;
  readonly promptIdPrefix?: string;
  readonly authTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function authenticateSshControlMaster(
  options: Omit<SshMasterOptions, "remoteCommand">,
  promptHandler: SshAuthPromptHandler,
  dependencies: AuthenticateSshControlMasterDependencies = {},
): Promise<SshControlMaster> {
  const { signal } = dependencies;
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (dependencies.spawnPty === undefined && usesSsh2Client()) {
    return authenticateSsh2Master(options, promptHandler, { signal });
  }
  const master = createSshControlMaster(options, {
    spawn: dependencies.spawn,
    unlink: dependencies.unlink,
  });
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const authTimeoutMs = dependencies.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  let ptyProcess: IPty;
  try {
    ptyProcess = spawnPty("ssh", buildSshControlMasterArgs(master), {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      env: process.env,
    });
  } catch (error) {
    master.dispose();
    return Promise.reject(error);
  }
  const sessionPrefix = dependencies.promptIdPrefix ?? `ssh-auth:${master.controlPath}`;

  let buffer = "";
  let settled = false;
  let promptInFlight = false;

  return new Promise<SshControlMaster>((resolve, reject) => {
    const prompts = new AbortController();
    const abort = () => failAuth(signal?.reason);
    const dataDisposable = ptyProcess.onData((chunk) => {
      buffer = trimAuthBuffer(buffer + chunk);
      void maybeHandlePrompt();
    });
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    armAuthTimer();
    const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      cleanupListeners();
      if (settled) return;
      settled = true;
      if (exitCode === 0) {
        resolve(master);
        return;
      }
      master.dispose();
      reject(createSshError(classifyPtyExit(buffer)));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    async function maybeHandlePrompt(): Promise<void> {
      if (settled || promptInFlight) return;
      const prompt = promptFromBuffer(buffer, options, sessionPrefix);
      if (!prompt) return;

      promptInFlight = true;
      disarmAuthTimer();
      try {
        const response = await promptHandler(prompt, prompts.signal);
        if (settled) return;
        armAuthTimer();
        if (response.kind === "password" && prompt.kind === "password") {
          ptyProcess.write(`${response.value}\r`);
          buffer = "";
          return;
        }
        if (response.kind === "host-key" && prompt.kind === "host-key") {
          ptyProcess.write("yes\r");
          buffer = "";
          return;
        }
        throw createSshError("ssh.auth-failed");
      } catch (error) {
        failAuth(
          createSshError(
            error instanceof AuthCancelledError ? "ssh.auth-cancelled" : "ssh.auth-failed",
            error,
          ),
        );
      } finally {
        promptInFlight = false;
      }
    }

    function armAuthTimer(): void {
      disarmAuthTimer();
      authTimer = setTimeout(() => {
        failAuth(createSshError(classifyPtyExit(buffer)));
      }, authTimeoutMs);
      authTimer.unref?.();
    }

    function disarmAuthTimer(): void {
      if (authTimer === null) return;
      clearTimeout(authTimer);
      authTimer = null;
    }

    function failAuth(error: unknown): void {
      if (settled) return;
      cleanupListeners();
      settled = true;
      master.dispose();
      ptyProcess.kill();
      reject(error);
    }

    function cleanupListeners(): void {
      signal?.removeEventListener("abort", abort);
      prompts.abort();
      disarmAuthTimer();
      dataDisposable.dispose();
      exitDisposable.dispose();
    }
  });
}

function promptFromBuffer(
  buffer: string,
  options: Omit<SshMasterOptions, "remoteCommand">,
  promptIdPrefix: string,
): SshAuthPrompt | null {
  const passwordMatch = PASSWORD_PROMPT_PATTERN.exec(buffer);
  if (passwordMatch) {
    const before = passwordMatch.index >= 0 ? buffer.slice(0, passwordMatch.index) : "";
    const retry = /permission denied|authentication failed|sorry, try again/i.test(before);
    return {
      kind: "password",
      promptId: `${promptIdPrefix}:password`,
      host: options.host,
      port: options.port,
      username: options.user,
      prompt: passwordMatch[1]?.trim() ?? "SSH password:",
      field: /passphrase/i.test(passwordMatch[1] ?? "") ? "passphrase" : "password",
      retry: retry || undefined,
    };
  }

  if (!HOST_KEY_PROMPT_PATTERN.test(buffer)) return null;
  const fingerprint = FINGERPRINT_PATTERN.exec(buffer);
  return {
    kind: "host-key",
    promptId: `${promptIdPrefix}:host-key`,
    host: options.host,
    port: options.port,
    username: options.user,
    keyType: fingerprint?.[1],
    fingerprint: fingerprint?.[2] ?? "unknown",
    message: buffer.trim(),
  };
}

function trimAuthBuffer(value: string): string {
  return value.length > 8_192 ? value.slice(-8_192) : value;
}

function classifyPtyExit(buffer: string): SshErrorCode {
  if (
    /connection refused|connection timed out|could not resolve hostname|name or service not known|no route to host|network is unreachable|operation timed out/i.test(
      buffer,
    )
  ) {
    return "ssh.connect-failed";
  }
  if (/host key verification failed|remote host identification has changed/i.test(buffer)) {
    return "ssh.connect-failed";
  }
  return "ssh.auth-failed";
}

function defaultSpawnPty(command: string, args: string[], options: Parameters<SpawnPty>[2]): IPty {
  const pty = require("node-pty") as typeof import("node-pty");
  return pty.spawn(command, args, options);
}
