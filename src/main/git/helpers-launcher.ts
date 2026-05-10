/**
 * Git helper launcher environment builder.
 *
 * The helpers run as Node scripts through Electron's executable
 * (`ELECTRON_RUN_AS_NODE=1`) behind generated executable wrappers because
 * Git askpass/editor variables must point to a command path it can exec
 * directly, not a quoted executable-plus-script compound command.
 */
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

type GitHelperKind = "askpass" | "editor";

/**
 * Records the active helper socket/token pair created by
 * `GitHelpersIpcManager`. GitRepository calls `buildHelperEnv` without
 * carrying the manager dependency through every operation.
 */
export function setDefaultGitHelperConnection(connection: GitHelperConnection | null): void {
  defaultConnection = connection;
}

/**
 * Builds the environment variables Git needs to invoke askpass and editor
 * helpers. Required prompt-disabling variables are always present; helper
 * command variables are included only for the helper families requested.
 */
export function buildHelperEnv(
  options: BuildHelperEnvOptions,
  runtime: BuildHelperEnvRuntime = {},
): NodeJS.ProcessEnv {
  const baseEnv = runtime.baseEnv ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const connection = runtime.connection ?? defaultConnection ?? getFallbackConnection();
  const electronPath = runtime.electronPath ?? process.execPath;
  const helperDir = runtime.helperDir ?? resolveDefaultHelperDir();
  const wrapperDir = runtime.wrapperDir ?? resolveDefaultWrapperDir(platform);

  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    NEXUS_HELPERS_SOCKET: connection.socketPath,
    NEXUS_HELPERS_TOKEN: connection.token,
    ELECTRON_RUN_AS_NODE: "1",
  };

  if (options.workspaceId) {
    env.NEXUS_HELPERS_WORKSPACE_ID = options.workspaceId;
  }

  if (options.askpass) {
    const askpassExecutable = ensureHelperWrapper({
      kind: "askpass",
      electronPath,
      helperPath: path.join(helperDir, "askpass-helper.cjs"),
      wrapperDir,
      platform,
    });
    env.GIT_ASKPASS = askpassExecutable;
    env.SSH_ASKPASS = askpassExecutable;
    env.SSH_ASKPASS_REQUIRE = "force";
    if (platform !== "win32") {
      env.DISPLAY = baseEnv.DISPLAY && baseEnv.DISPLAY.length > 0 ? baseEnv.DISPLAY : ":0";
    }
  }

  if (options.editor) {
    env.GIT_EDITOR = ensureHelperWrapper({
      kind: "editor",
      electronPath,
      helperPath: path.join(helperDir, "git-editor-helper.cjs"),
      wrapperDir,
      platform,
    });
  }

  return env;
}

/**
 * Creates or refreshes the executable wrapper Git will launch as askpass or
 * editor. The wrapper carries the Electron executable and helper script paths
 * internally, so Git receives a single executable path instead of a command
 * string that askpass cannot parse.
 */
export function ensureHelperWrapper(options: {
  readonly kind: GitHelperKind;
  readonly electronPath: string;
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
      ? buildWindowsHelperWrapper(options.electronPath, options.helperPath)
      : buildPosixHelperWrapper(options.electronPath, options.helperPath);

  fs.writeFileSync(wrapperPath, content, { mode: 0o700 });
  if (options.platform !== "win32") {
    fs.chmodSync(wrapperPath, 0o700);
  }
  return wrapperPath;
}

/**
 * Quotes one shell argument for the generated POSIX wrapper. Single-quote
 * wrapping keeps spaces in app names and helper paths intact.
 */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Writes a POSIX wrapper that forwards Git's prompt/file argument safely to
 * Electron running the helper CommonJS script.
 */
function buildPosixHelperWrapper(electronPath: string, helperPath: string): string {
  return [
    "#!/bin/sh",
    "ELECTRON_RUN_AS_NODE=1",
    "export ELECTRON_RUN_AS_NODE",
    `exec ${quoteShellArg(electronPath)} ${quoteShellArg(helperPath)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Writes a Windows command wrapper for Git for Windows. The helper protocols
 * only use Git's first appended argument: askpass prompt text or editor file.
 */
function buildWindowsHelperWrapper(electronPath: string, helperPath: string): string {
  return [
    "@echo off",
    "setlocal",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `${quoteCmdPath(electronPath)} ${quoteCmdPath(helperPath)} "%~1"`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

/**
 * Quotes a path for the generated `.cmd` wrapper.
 */
function quoteCmdPath(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Locates the helper scripts in development and in the bundled main output.
 * Tests may override this through `runtime.helperDir`.
 */
function resolveDefaultHelperDir(): string {
  const bundledDir = path.join(__dirname, "git");
  if (fs.existsSync(path.join(bundledDir, "askpass-helper.cjs"))) return bundledDir;

  const siblingDir = __dirname;
  if (fs.existsSync(path.join(siblingDir, "askpass-helper.cjs"))) return siblingDir;

  const sourceDir = path.join(process.cwd(), "src", "main", "git");
  if (fs.existsSync(path.join(sourceDir, "askpass-helper.cjs"))) return sourceDir;

  return siblingDir;
}

/**
 * Places generated helper wrappers in a private temp directory whose path is
 * stable for this process and avoids userData paths that may contain spaces.
 */
function resolveDefaultWrapperDir(platform: NodeJS.Platform): string {
  return path.join(os.tmpdir(), `nexus-git-helper-wrappers-${platform}-${process.pid}`);
}

/**
 * Provides a non-empty socket/token pair for tests and for Git operations that
 * do not actually prompt before the main manager has started.
 */
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
