/**
 * A host's effective OpenSSH client settings, for the ssh2 client.
 *
 * `ssh -G` prints the settings OpenSSH itself would connect with — the user's
 * ~/.ssh/config with its Host and Match blocks and Include files, over
 * OpenSSH's defaults — so the ssh2 client connects where `ssh` would without
 * a config parser of its own. Without an OpenSSH client the host is used as
 * given, with OpenSSH's defaults.
 *
 * NEXUS_SSH_CONFIG names a config file to read in place of ~/.ssh/config
 * (`ssh -F`), to try the client against a test host.
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface SshTarget {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
}

export type StrictHostKeyChecking = "ask" | "yes" | "accept-new" | "no";

export interface SshHostConfig {
  /** The host as the user named it, for prompts. */
  readonly host: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly identityFiles: readonly string[];
  readonly identitiesOnly: boolean;
  /** The agent socket or pipe, or null for none. */
  readonly identityAgent: string | null;
  /** Jump hosts in order, as `[user@]host[:port]`. */
  readonly proxyJump: readonly string[];
  readonly proxyCommand: string | null;
  readonly connectTimeoutMs: number | null;
  readonly hostKeyAlias: string | null;
  readonly knownHostsFiles: readonly string[];
  readonly globalKnownHostsFiles: readonly string[];
  readonly strictHostKeyChecking: StrictHostKeyChecking;
  readonly hashKnownHosts: boolean;
  readonly preferredAuthentications: readonly string[];
}

export interface ResolveSshHostConfigDependencies {
  /** Runs `ssh -G`; resolves its stdout, or null when there is no OpenSSH client. */
  readonly printConfig?: (args: readonly string[]) => Promise<string | null>;
  readonly homedir?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const PRINT_CONFIG_TIMEOUT_MS = 10_000;

const DEFAULT_IDENTITY_FILES = [
  "~/.ssh/id_rsa",
  "~/.ssh/id_ecdsa",
  "~/.ssh/id_ecdsa_sk",
  "~/.ssh/id_ed25519",
  "~/.ssh/id_ed25519_sk",
  "~/.ssh/id_dsa",
];

const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

/** The setting that turns each authentication method on or off. */
const AUTHENTICATION_SETTINGS: Readonly<Record<string, string>> = {
  publickey: "pubkeyauthentication",
  "keyboard-interactive": "kbdinteractiveauthentication",
  password: "passwordauthentication",
};

export async function resolveSshHostConfig(
  target: SshTarget,
  dependencies: ResolveSshHostConfigDependencies = {},
): Promise<SshHostConfig> {
  const printConfig = dependencies.printConfig ?? printOpenSshConfig;
  const env = dependencies.env ?? process.env;
  const args = ["-G"];
  if (env.NEXUS_SSH_CONFIG) args.push("-F", env.NEXUS_SSH_CONFIG);
  if (target.port !== undefined) args.push("-p", String(target.port));
  if (target.user) args.push("-l", target.user);
  if (target.identityFile) args.push("-i", target.identityFile);
  args.push("--", target.host);
  const printed = await printConfig(args);
  const settings = printed === null ? new Map<string, string[]>() : parsePrintedConfig(printed);
  return buildHostConfig(target, settings, {
    homedir: dependencies.homedir ?? os.homedir(),
    platform: dependencies.platform ?? process.platform,
    env,
    printed: printed !== null,
  });
}

/** Splits `ssh -G` output into its keys, each with every value given. */
export function parsePrintedConfig(output: string): Map<string, string[]> {
  const settings = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const values = settings.get(key) ?? [];
    values.push(match[2]);
    settings.set(key, values);
  }
  return settings;
}

function buildHostConfig(
  target: SshTarget,
  settings: Map<string, string[]>,
  context: {
    readonly homedir: string;
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly printed: boolean;
  },
): SshHostConfig {
  const first = (key: string): string | undefined => settings.get(key)?.[0];
  const hostname = first("hostname") ?? target.host;
  const user = first("user") ?? target.user ?? os.userInfo().username;
  const port = Number(first("port") ?? target.port ?? 22);
  const tokens = { homedir: context.homedir, hostname, user, port, env: context.env };
  const expand = (value: string): string => expandPath(value, tokens);

  const identityFiles = context.printed
    ? (settings.get("identityfile") ?? [])
    : [...(target.identityFile ? [target.identityFile] : []), ...DEFAULT_IDENTITY_FILES];

  const knownHosts = first("userknownhostsfile") ?? "~/.ssh/known_hosts ~/.ssh/known_hosts2";
  const globalKnownHosts =
    first("globalknownhostsfile") ??
    (context.platform === "win32"
      ? "__PROGRAMDATA__/ssh/ssh_known_hosts"
      : "/etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2");

  const connectTimeout = first("connecttimeout");
  const strict = first("stricthostkeychecking")?.toLowerCase();
  return {
    host: target.host,
    hostname,
    port: Number.isInteger(port) && port > 0 ? port : 22,
    user,
    identityFiles: identityFiles.map(expand),
    identitiesOnly: first("identitiesonly")?.toLowerCase() === "yes",
    identityAgent: resolveIdentityAgent(
      first("identityagent"),
      context.platform,
      context.env,
      expand,
    ),
    proxyJump: parseList(first("proxyjump"), ","),
    proxyCommand: noneToNull(first("proxycommand")),
    connectTimeoutMs:
      connectTimeout && /^\d+$/.test(connectTimeout) && Number(connectTimeout) > 0
        ? Number(connectTimeout) * 1000
        : null,
    hostKeyAlias: noneToNull(first("hostkeyalias")),
    knownHostsFiles: parseList(knownHosts, /\s+/).map(expand),
    globalKnownHostsFiles: parseList(globalKnownHosts, /\s+/).map(expand),
    strictHostKeyChecking:
      strict === "yes" || strict === "accept-new"
        ? strict
        : strict === "no" || strict === "off"
          ? "no"
          : "ask",
    hashKnownHosts: first("hashknownhosts")?.toLowerCase() === "yes",
    preferredAuthentications: parseList(
      first("preferredauthentications") ?? "publickey,keyboard-interactive,password",
      ",",
    ).filter((method) => {
      // PubkeyAuthentication, KbdInteractiveAuthentication and
      // PasswordAuthentication turn a method off; -G prints yes/no or true/false.
      const setting = AUTHENTICATION_SETTINGS[method];
      const value = setting ? first(setting)?.toLowerCase() : undefined;
      return value !== "no" && value !== "false";
    }),
  };
}

/**
 * The agent to ask for keys: IdentityAgent when set, else SSH_AUTH_SOCK, else
 * on Windows the OpenSSH agent service's pipe.
 */
function resolveIdentityAgent(
  configured: string | undefined,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  expand: (value: string) => string,
): string | null {
  if (configured !== undefined && configured.toLowerCase() === "none") return null;
  if (configured !== undefined && configured !== "SSH_AUTH_SOCK") {
    if (configured.startsWith("$")) return env[configured.slice(1)] || null;
    return expand(configured);
  }
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  return platform === "win32" ? WINDOWS_AGENT_PIPE : null;
}

/** Expands the `~`, `%` tokens and `__PROGRAMDATA__` OpenSSH allows in paths. */
function expandPath(
  value: string,
  tokens: {
    readonly homedir: string;
    readonly hostname: string;
    readonly user: string;
    readonly port: number;
    readonly env: NodeJS.ProcessEnv;
  },
): string {
  let expanded = value.replace(/%([%dhrpu])/g, (match, token: string) => {
    switch (token) {
      case "%":
        return "%";
      case "d":
        return tokens.homedir;
      case "h":
        return tokens.hostname;
      case "r":
        return tokens.user;
      case "p":
        return String(tokens.port);
      case "u":
        return os.userInfo().username;
      default:
        return match;
    }
  });
  expanded = expanded.replace(/\$\{(\w+)\}/g, (_match, name: string) => tokens.env[name] ?? "");
  if (expanded.startsWith("__PROGRAMDATA__")) {
    expanded = (tokens.env.ProgramData ?? "C:\\ProgramData") + expanded.slice(15);
  }
  if (expanded === "~") return tokens.homedir;
  if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    return path.join(tokens.homedir, expanded.slice(2));
  }
  return expanded;
}

function parseList(value: string | undefined, separator: string | RegExp): string[] {
  if (value === undefined || value.toLowerCase() === "none") return [];
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function noneToNull(value: string | undefined): string | null {
  return value === undefined || value.toLowerCase() === "none" ? null : value;
}

/** Runs the OpenSSH client's `ssh -G`; null when it is missing or fails. */
function printOpenSshConfig(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "ssh",
      [...args],
      { timeout: PRINT_CONFIG_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}
