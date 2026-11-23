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
  readonly host: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly identityFiles: readonly string[];
  readonly identitiesOnly: boolean;
  readonly identityAgent: string | null;
  readonly forwardAgent: string | null;
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
  const identityAgent = resolveIdentityAgent(
    first("identityagent"),
    context.platform,
    context.env,
    expand,
  );
  return {
    host: target.host,
    hostname,
    port: Number.isInteger(port) && port > 0 ? port : 22,
    user,
    identityFiles: identityFiles.map(expand),
    identitiesOnly: first("identitiesonly")?.toLowerCase() === "yes",
    identityAgent,
    forwardAgent: resolveForwardAgent(first("forwardagent"), identityAgent, context.env, expand),
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
      const setting = AUTHENTICATION_SETTINGS[method];
      const value = setting ? first(setting)?.toLowerCase() : undefined;
      return value !== "no" && value !== "false";
    }),
  };
}

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

function resolveForwardAgent(
  configured: string | undefined,
  identityAgent: string | null,
  env: NodeJS.ProcessEnv,
  expand: (value: string) => string,
): string | null {
  const value = configured?.toLowerCase();
  if (configured === undefined || value === "no") return null;
  if (value === "yes") return identityAgent;
  if (configured.startsWith("$")) return env[configured.slice(1)] || null;
  return expand(configured);
}

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
