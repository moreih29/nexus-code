/**
 * shells.ts — finds the shells installed on this machine and resolves the
 * one a local terminal should run (Settings › Terminal › Default shell).
 *
 * Only local workspaces use this. An SSH workspace's agent picks the remote
 * host's login shell itself, so nothing here is sent to a remote.
 *
 * `systemDefaultShell` mirrors the agent's own `defaultShell`
 * (internal/pty/terminal_*.go): it is what a terminal runs when no shell is
 * chosen, and what the settings show as "System default".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import type { ShellChoice, ShellInfo } from "../../../shared/pty/shell";

/** The machine the shells are looked up on; tests pass a fake one. */
export interface ShellHost {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  isFile(path: string): boolean;
  readText(path: string): string | null;
  realpath(path: string): string;
}

export function nodeShellHost(): ShellHost {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    isFile(path) {
      try {
        return fs.statSync(path).isFile();
      } catch {
        return false;
      }
    },
    readText(path) {
      try {
        return fs.readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    realpath(path) {
      try {
        return fs.realpathSync(path);
      } catch {
        return path;
      }
    },
  };
}

// /etc/shells lists these too, but none is a shell to open a terminal with.
const NOT_TERMINAL_SHELLS = new Set(["false", "nologin", "git-shell", "rbash", "screen", "tmux"]);

// Shells people install without adding to /etc/shells, and where they land
// when the app's PATH (a GUI app's minimal one on macOS) misses them.
const EXTRA_UNIX_SHELLS = ["fish", "nu", "pwsh", "xonsh", "elvish"];
const UNIX_NAMES: Record<string, string> = { nu: "Nushell", pwsh: "PowerShell" };

const WINDOWS_NAMES: Record<string, string> = {
  powershell: "Windows PowerShell",
  pwsh: "PowerShell",
  cmd: "Command Prompt",
  "git-bash": "Git Bash",
  nu: "Nushell",
};

function pathApi(host: ShellHost): typeof nodePath.posix {
  return host.platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** Reads an environment variable; Windows names are case-insensitive. */
function getEnv(host: ShellHost, name: string): string | undefined {
  if (host.platform !== "win32") return host.env[name] || undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(host.env)) {
    if (key.toLowerCase() === lower && value) return value;
  }
  return undefined;
}

/** Finds a program on PATH, trying PATHEXT's extensions on Windows. */
export function findOnPath(host: ShellHost, name: string): string | null {
  const p = pathApi(host);
  const exts =
    host.platform === "win32" && p.extname(name) === ""
      ? (getEnv(host, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((ext) => ext.toLowerCase())
      : [""];
  const dirs = (getEnv(host, "PATH") ?? "").split(host.platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (host.isFile(candidate)) return candidate;
    }
  }
  return null;
}

function firstFile(
  host: ShellHost,
  candidates: readonly (string | null | undefined)[],
): string | null {
  for (const candidate of candidates) {
    if (candidate && host.isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Git Bash: `bin\bash.exe` of a Git for Windows install, found from git.exe on
 * PATH or the usual install folders. `usr\bin\bash.exe` must sit next to it,
 * which keeps an MSYS2 or Cygwin bash from passing for Git Bash.
 */
function findGitBash(host: ShellHost): string | null {
  const p = pathApi(host);
  const roots: string[] = [];
  const git = findOnPath(host, "git.exe");
  if (git) {
    // <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe
    let dir = p.dirname(git);
    if (
      p.basename(dir).toLowerCase() === "bin" &&
      p.basename(p.dirname(dir)).toLowerCase() === "mingw64"
    ) {
      dir = p.dirname(dir);
    }
    roots.push(p.dirname(dir));
  }
  for (const base of [
    getEnv(host, "ProgramW6432"),
    getEnv(host, "ProgramFiles"),
    getEnv(host, "ProgramFiles(x86)"),
  ]) {
    if (base) roots.push(p.join(base, "Git"));
  }
  const localAppData = getEnv(host, "LOCALAPPDATA");
  if (localAppData) roots.push(p.join(localAppData, "Programs", "Git"));
  roots.push(p.join(host.homedir, "scoop", "apps", "git", "current"));

  for (const root of roots) {
    const bash = p.join(root, "bin", "bash.exe");
    if (host.isFile(bash) && host.isFile(p.join(root, "usr", "bin", "bash.exe"))) return bash;
  }
  return null;
}

function detectWindowsShells(host: ShellHost): ShellInfo[] {
  const p = pathApi(host);
  const systemRoot = getEnv(host, "SystemRoot") ?? "C:\\Windows";
  const programFiles = getEnv(host, "ProgramFiles");
  const found: [id: string, path: string | null, args?: string[]][] = [
    [
      "powershell",
      firstFile(host, [
        p.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        findOnPath(host, "powershell.exe"),
      ]),
    ],
    [
      "pwsh",
      firstFile(host, [
        findOnPath(host, "pwsh.exe"),
        programFiles && p.join(programFiles, "PowerShell", "7", "pwsh.exe"),
      ]),
    ],
    ["cmd", firstFile(host, [getEnv(host, "ComSpec"), p.join(systemRoot, "System32", "cmd.exe")])],
    // A login shell reads /etc/profile, which sets up Git Bash's prompt and PATH.
    ["git-bash", findGitBash(host), ["--login", "-i"]],
    ["nu", findOnPath(host, "nu.exe")],
  ];
  const shells: ShellInfo[] = [];
  for (const [id, path, args = []] of found) {
    if (path) shells.push({ id, name: WINDOWS_NAMES[id] ?? id, path, args });
  }
  return shells;
}

function unixShell(path: string): ShellInfo {
  const base = nodePath.posix.basename(path);
  return { id: path, name: UNIX_NAMES[base] ?? base, path, args: [] };
}

function detectUnixShells(host: ShellHost): ShellInfo[] {
  const p = nodePath.posix;
  const shells: ShellInfo[] = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    const real = host.realpath(path);
    if (seen.has(real)) return;
    seen.add(real);
    shells.push(unixShell(path));
  };

  for (const line of (host.readText("/etc/shells") ?? "").split("\n")) {
    const path = line.trim();
    if (!path.startsWith("/") || NOT_TERMINAL_SHELLS.has(p.basename(path))) continue;
    if (host.isFile(path)) add(path);
  }

  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/snap/bin",
    p.join(host.homedir, ".cargo", "bin"),
    p.join(host.homedir, ".local", "bin"),
  ];
  for (const name of EXTRA_UNIX_SHELLS) {
    if (shells.some((s) => p.basename(s.path) === name)) continue;
    const path =
      findOnPath(host, name) ??
      firstFile(
        host,
        dirs.map((dir) => p.join(dir, name)),
      );
    if (path) add(path);
  }
  return shells;
}

/** The shells installed on this machine, in the order the settings list them. */
export function detectShells(host: ShellHost): ShellInfo[] {
  return host.platform === "win32" ? detectWindowsShells(host) : detectUnixShells(host);
}

/** The shell a terminal runs when none is chosen; see the agent's `defaultShell`. */
export function systemDefaultShell(host: ShellHost): ShellInfo {
  if (host.platform === "win32") {
    const powershell = findOnPath(host, "powershell.exe");
    if (powershell)
      return { id: "powershell", name: WINDOWS_NAMES.powershell ?? "", path: powershell, args: [] };
    const comspec = getEnv(host, "ComSpec")?.trim();
    return { id: "cmd", name: WINDOWS_NAMES.cmd ?? "", path: comspec || "cmd.exe", args: [] };
  }
  const shell = host.env.SHELL?.trim();
  if (shell) return unixShell(shell);
  return unixShell(firstFile(host, ["/bin/bash", "/bin/zsh", "/bin/sh"]) ?? "/bin/sh");
}

/**
 * Finds the program a custom shell names: a path as given, or a bare name
 * ("nu", "fish") on PATH. Null when there is no such file.
 */
export function findShellProgram(host: ShellHost, program: string): string | null {
  const p = pathApi(host);
  const trimmed = program.trim();
  if (trimmed === "") return null;
  if (p.isAbsolute(trimmed)) return host.isFile(trimmed) ? trimmed : null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  return findOnPath(host, trimmed);
}

export type ResolvedShell = { shell: ShellInfo } | { missing: string };

/**
 * The shell to start for a choice, or the name of the one that can't be found
 * (uninstalled, moved), so the caller can fall back and say so.
 */
export function resolveShellChoice(host: ShellHost, choice: ShellChoice): ResolvedShell {
  if (choice.kind === "detected") {
    const shell = detectShells(host).find((s) => s.id === choice.id);
    if (shell) return { shell };
    const name =
      host.platform === "win32"
        ? (WINDOWS_NAMES[choice.id] ?? choice.id)
        : unixShell(choice.id).name;
    return { missing: name };
  }
  const path = findShellProgram(host, choice.path);
  if (!path) return { missing: choice.path };
  return {
    shell: { id: "custom", name: pathApi(host).basename(path), path, args: choice.args ?? [] },
  };
}
