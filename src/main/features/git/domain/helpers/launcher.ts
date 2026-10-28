/**
 * Git helper launcher environment builder.
 *
 * Askpass now runs on the Go agent host. This module only keeps the
 * Electron-host editor helper environment used by commit-message editing.
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

type GitHelperKind = "editor";

/**
 * Records the active helper socket/token pair created by
 * `GitHelpersIpcManager`. GitRepository calls `buildHelperEnv` without
 * carrying the manager dependency through every operation.
 */
export function setDefaultGitHelperConnection(connection: GitHelperConnection | null): void {
  defaultConnection = connection;
}

/**
 * Builds the environment variables Git needs for prompt-capable commands.
 * Askpass is handled by the Go agent host; editor still uses the Electron
 * helper wrapper when requested.
 */
export function buildHelperEnv(
  options: BuildHelperEnvOptions,
  runtime: BuildHelperEnvRuntime = {},
): NodeJS.ProcessEnv {
  const baseEnv = runtime.baseEnv ?? process.env;
  const platform = runtime.platform ?? process.platform;
  const electronPath = runtime.electronPath ?? resolveDefaultElectronPath();
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
      electronPath,
      helperPath: path.join(helperDir, "editor-helper.cjs"),
      wrapperDir,
      platform,
    });
    // Git runs the editor through `sh -c` when the value holds shell
    // metacharacters, and every Windows path does: sh would eat the
    // backslashes. Quoting keeps them, and any spaces, intact.
    env.GIT_EDITOR = platform === "win32" ? quoteShellArg(editorWrapper) : editorWrapper;
  }

  return env;
}

/**
 * Creates or refreshes the executable wrapper Git will launch as the editor.
 * The wrapper carries the Electron executable and helper script paths
 * internally, so Git receives a single executable path.
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
 * only uses Git's first appended argument: the editor file.
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
 * The executable the editor wrapper starts: this one, or, when the app runs
 * from an MSIX package, the package's alias for it. Only a process with the
 * package's identity may run the package's files, and git and the shell it
 * starts the wrapper through have none; starting the alias gives the editor
 * that identity.
 */
function resolveDefaultElectronPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  const alias =
    process.windowsStore && localAppData ? packageAliasPath(process.execPath, localAppData) : null;
  return alias ?? process.execPath;
}

/**
 * The App Execution Alias the MSIX package declares for the app
 * (build/appx-manifest.cjs), given the path of the app's executable in the
 * installed package. Null when that path is not in a package's install
 * directory, which bears the package's full name,
 * `<name>_<version>_<arch>_<resource id>_<publisher id>`.
 */
export function packageAliasPath(execPath: string, localAppData: string): string | null {
  const fullName = path.win32.basename(path.win32.dirname(path.win32.dirname(execPath))).split("_");
  if (fullName.length !== 5) return null;
  const familyName = `${fullName[0]}_${fullName[4]}`;
  return path.win32.join(localAppData, "Microsoft", "WindowsApps", familyName, "nexuscode.exe");
}

/**
 * Locates the editor helper script in development and in the bundled main
 * output. Tests may override this through `runtime.helperDir`.
 */
function resolveDefaultHelperDir(): string {
  const bundledDir = path.join(__dirname, "git");
  if (fs.existsSync(path.join(bundledDir, "editor-helper.cjs"))) return bundledDir;

  const siblingDir = __dirname;
  if (fs.existsSync(path.join(siblingDir, "editor-helper.cjs"))) return siblingDir;

  const sourceDir = path.join(process.cwd(), "src", "main", "features", "git", "domain", "helpers");
  if (fs.existsSync(path.join(sourceDir, "editor-helper.cjs"))) return sourceDir;

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
