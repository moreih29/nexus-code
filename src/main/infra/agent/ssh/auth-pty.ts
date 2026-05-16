import type { IPty } from "node-pty";
import type { SshAuthPrompt, SshAuthResponse } from "../../../../shared/ssh/auth-prompt";
import {
  buildSshControlMasterArgs,
  createSshControlMaster,
  type SpawnSshProcess,
  type SshControlMaster,
  type SshMasterOptions,
} from "./master";
import { createSshError } from "../pipe";

const PASSWORD_PROMPT_PATTERN = /([^\r\n]*?(?:password|passphrase)\s*(?:for [^:]+)?\s*:)\s*$/i;
const HOST_KEY_PROMPT_PATTERN =
  /Are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\?/i;
const FINGERPRINT_PATTERN = /([A-Z0-9]+) key fingerprint is (SHA256:[^\s.]+)/i;
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;

export type SshAuthPromptHandler = (prompt: SshAuthPrompt) => Promise<SshAuthResponse>;
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
}

/**
 * Runs OpenSSH in a PTY long enough to satisfy interactive password and host-key
 * prompts, leaving behind a reusable ControlMaster socket for batch channels.
 */
export function authenticateSshControlMaster(
  options: Omit<SshMasterOptions, "remoteCommand">,
  promptHandler: SshAuthPromptHandler,
  dependencies: AuthenticateSshControlMasterDependencies = {},
): Promise<SshControlMaster> {
  const master = createSshControlMaster(options, {
    spawn: dependencies.spawn,
    unlink: dependencies.unlink,
  });
  const spawnPty = dependencies.spawnPty ?? defaultSpawnPty;
  const authTimeoutMs = dependencies.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const ptyProcess = spawnPty("ssh", buildSshControlMasterArgs(master), {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    env: process.env,
  });
  const sessionPrefix = dependencies.promptIdPrefix ?? `ssh-auth:${master.controlPath}`;

  let buffer = "";
  let settled = false;
  let promptInFlight = false;

  return new Promise<SshControlMaster>((resolve, reject) => {
    const dataDisposable = ptyProcess.onData((chunk) => {
      buffer = trimAuthBuffer(buffer + chunk);
      void maybeHandlePrompt();
    });
    const authTimer = setTimeout(() => {
      failAuth(createSshError("ssh.auth-failed"));
    }, authTimeoutMs);
    authTimer.unref?.();
    const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      cleanupListeners();
      if (settled) return;
      settled = true;
      if (exitCode === 0) {
        resolve(master);
        return;
      }
      master.dispose();
      reject(createSshError("ssh.auth-failed"));
    });

    async function maybeHandlePrompt(): Promise<void> {
      if (settled || promptInFlight) return;
      const prompt = promptFromBuffer(buffer, options, sessionPrefix);
      if (!prompt) return;

      promptInFlight = true;
      try {
        const response = await promptHandler(prompt);
        if (settled) return;
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
        failAuth(createSshError("ssh.auth-failed", error));
      } finally {
        promptInFlight = false;
      }
    }

    function failAuth(error: Error): void {
      if (settled) return;
      cleanupListeners();
      settled = true;
      master.dispose();
      ptyProcess.kill();
      reject(error);
    }

    function cleanupListeners(): void {
      clearTimeout(authTimer);
      dataDisposable.dispose();
      exitDisposable.dispose();
    }
  });
}

/** Converts buffered OpenSSH PTY text into the next renderer prompt, if any. */
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

function defaultSpawnPty(command: string, args: string[], options: Parameters<SpawnPty>[2]): IPty {
  // node-pty is a native runtime dependency and must stay external to Vite.
  const pty = require("node-pty") as typeof import("node-pty");
  return pty.spawn(command, args, options);
}
