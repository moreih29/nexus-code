import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitHelperConnection {
  readonly socketPath: string;
  readonly token: string;
}

export interface BuildHelperEnvOptions {
  readonly askpass?: boolean;
  readonly editor?: boolean;
  readonly workspaceId?: string;
}

export interface BuildHelperEnvRuntime {
  readonly connection?: GitHelperConnection;
  readonly electronPath?: string;
  readonly helperDir?: string;
  readonly wrapperDir?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

let defaultConnection: GitHelperConnection | null = null;
let fallbackConnection: GitHelperConnection | null = null;

type GitHelperKind = "editor";

export function setDefaultGitHelperConnection(connection: GitHelperConnection | null): void {
  defaultConnection = connection;
}

export function buildHelperEnv(
  options: BuildHelperEnvOptions,
  runtime: BuildHelperEnvRuntime = {},
): NodeJS.ProcessEnv {
  const baseEnv = runtime.baseEnv ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const electronCommand = runtime.electronPath
    ? [runtime.electronPath]
    : resolveDefaultElectronCommand();
  const helperDir = runtime.helperDir ?? resolveDefaultHelperDir();
  const wrapperDir = runtime.wrapperDir ?? resolveDefaultWrapperDir(platform);

  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
  };

  if (options.workspaceId) {
    env.NEXUS_HELPERS_WORKSPACE_ID = options.workspaceId;
  }

  if (options.askpass) {
    env.SSH_ASKPASS_REQUIRE = "force";
    if (platform !== "win32") {
      env.DISPLAY = baseEnv.DISPLAY && baseEnv.DISPLAY.length > 0 ? baseEnv.DISPLAY : ":0";
    }
  }

  if (options.editor) {
    const connection = runtime.connection ?? defaultConnection ?? getFallbackConnection();
    env.NEXUS_HELPERS_SOCKET = connection.socketPath;
    env.NEXUS_HELPERS_TOKEN = connection.token;
    env.ELECTRON_RUN_AS_NODE = "1";
    const editorWrapper = ensureHelperWrapper({
      kind: "editor",
      electronCommand,
      helperPath: path.join(helperDir, "editor-helper.cjs"),
      wrapperDir,
      platform,
    });
    env.GIT_EDITOR = platform === "win32" ? quoteShellArg(editorWrapper) : editorWrapper;
  }

  return env;
}

export function ensureHelperWrapper(options: {
  readonly kind: GitHelperKind;
  readonly electronCommand: readonly string[];
  readonly helperPath: string;
  readonly wrapperDir: string;
  readonly platform: NodeJS.Platform;
}): string {
  fs.mkdirSync(options.wrapperDir, { recursive: true, mode: 0o700 });
  if (options.platform !== "win32") {
    fs.chmodSync(options.wrapperDir, 0o700);
  }

  const wrapperPath = path.join(
    options.wrapperDir,
    `nexus-git-${options.kind}-helper${options.platform === "win32" ? ".cmd" : ""}`,
  );
  const content =
    options.platform === "win32"
      ? buildWindowsHelperWrapper(options.electronCommand, options.helperPath)
      : buildPosixHelperWrapper(options.electronCommand, options.helperPath);

  fs.writeFileSync(wrapperPath, content, { mode: 0o700 });
  if (options.platform !== "win32") {
    fs.chmodSync(wrapperPath, 0o700);
  }
  return wrapperPath;
}

export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildPosixHelperWrapper(electronCommand: readonly string[], helperPath: string): string {
  return [
    "#!/bin/sh",
    "ELECTRON_RUN_AS_NODE=1",
    "export ELECTRON_RUN_AS_NODE",
    `exec ${[...electronCommand, helperPath].map(quoteShellArg).join(" ")} "$@"`,
    "",
  ].join("\n");
}

function buildWindowsHelperWrapper(electronCommand: readonly string[], helperPath: string): string {
  return [
    "@echo off",
    "setlocal",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `${[...electronCommand, helperPath].map(quoteCmdPath).join(" ")} "%~1"`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

function quoteCmdPath(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function resolveDefaultElectronCommand(): readonly string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const alias =
    process.windowsStore && localAppData ? agentAliasPath(process.execPath, localAppData) : null;
  return alias ? [alias, "package-run", process.execPath] : [process.execPath];
}

export function agentAliasPath(execPath: string, localAppData: string): string | null {
  const fullName = path.win32.basename(path.win32.dirname(path.win32.dirname(execPath))).split("_");
  if (fullName.length !== 5) return null;
  const familyName = `${fullName[0]}_${fullName[4]}`;
  return path.win32.join(
    localAppData,
    "Microsoft",
    "WindowsApps",
    familyName,
    "nexuscode-agent.exe",
  );
}

function resolveDefaultHelperDir(): string {
  const bundledDir = path.join(__dirname, "git");
  if (fs.existsSync(path.join(bundledDir, "editor-helper.cjs"))) return bundledDir;

  const siblingDir = __dirname;
  if (fs.existsSync(path.join(siblingDir, "editor-helper.cjs"))) return siblingDir;

  const sourceDir = path.join(process.cwd(), "src", "main", "features", "git", "domain", "helpers");
  if (fs.existsSync(path.join(sourceDir, "editor-helper.cjs"))) return sourceDir;

  return siblingDir;
}

function resolveDefaultWrapperDir(platform: NodeJS.Platform): string {
  return path.join(os.tmpdir(), `nexus-git-helper-wrappers-${platform}-${process.pid}`);
}

function getFallbackConnection(): GitHelperConnection {
  if (!fallbackConnection) {
    fallbackConnection = {
      socketPath:
        process.env.NEXUS_HELPERS_SOCKET ??
        path.join(os.tmpdir(), `nexus-helpers-unconfigured-${process.pid}.sock`),
      token: process.env.NEXUS_HELPERS_TOKEN ?? crypto.randomBytes(32).toString("hex"),
    };
  }
  return fallbackConnection;
}
