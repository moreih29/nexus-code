import { describe, expect, test } from "bun:test";
import {
  detectShells,
  findShellProgram,
  resolveShellChoice,
  type ShellHost,
  systemDefaultShell,
} from "../../../../src/main/features/pty/shells";

function fakeHost(
  platform: NodeJS.Platform,
  files: string[],
  env: Record<string, string> = {},
  opts: { etcShells?: string; realpaths?: Record<string, string> } = {},
): ShellHost {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const present = new Set(files.map(norm));
  return {
    platform,
    env,
    homedir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    isFile: (p) => present.has(norm(p)),
    readText: (p) => (p === "/etc/shells" ? (opts.etcShells ?? null) : null),
    realpath: (p) => opts.realpaths?.[p] ?? p,
  };
}

const WIN_ENV = {
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  // Windows env names are case-insensitive; the PATH variable is "Path".
  Path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\Git\\cmd",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

describe("detectShells on Windows", () => {
  test("finds Windows PowerShell, cmd and Git Bash (from git.exe on PATH)", () => {
    const host = fakeHost(
      "win32",
      [
        POWERSHELL,
        "C:\\Windows\\system32\\cmd.exe",
        "C:\\Program Files\\Git\\cmd\\git.exe",
        GIT_BASH,
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      ],
      WIN_ENV,
    );
    expect(detectShells(host)).toEqual([
      { id: "powershell", name: "Windows PowerShell", path: POWERSHELL, args: [] },
      { id: "cmd", name: "Command Prompt", path: "C:\\Windows\\system32\\cmd.exe", args: [] },
      { id: "git-bash", name: "Git Bash", path: GIT_BASH, args: ["--login", "-i"] },
    ]);
  });

  test("finds PowerShell 7 and Nushell on PATH", () => {
    const host = fakeHost(
      "win32",
      ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Program Files\\nu\\bin\\nu.exe"],
      { ...WIN_ENV, Path: "C:\\Program Files\\PowerShell\\7;C:\\Program Files\\nu\\bin" },
    );
    expect(detectShells(host).map((s) => [s.id, s.name, s.path])).toEqual([
      ["pwsh", "PowerShell", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
      ["nu", "Nushell", "C:\\Program Files\\nu\\bin\\nu.exe"],
    ]);
  });

  test("finds Git Bash in a per-user install with no git on PATH", () => {
    const root = "C:\\Users\\me\\AppData\\Local\\Programs\\Git";
    const host = fakeHost("win32", [`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`], {
      ...WIN_ENV,
      Path: "",
    });
    expect(detectShells(host).find((s) => s.id === "git-bash")?.path).toBe(
      `${root}\\bin\\bash.exe`,
    );
  });

  test("an MSYS2 bash next to git.exe isn't taken for Git Bash", () => {
    const host = fakeHost(
      "win32",
      ["C:\\msys64\\usr\\bin\\git.exe", "C:\\msys64\\usr\\bin\\bash.exe"],
      { ...WIN_ENV, Path: "C:\\msys64\\usr\\bin" },
    );
    expect(detectShells(host).some((s) => s.id === "git-bash")).toBe(false);
  });
});

describe("detectShells on macOS and Linux", () => {
  test("lists /etc/shells once per file, without the non-terminal entries", () => {
    const host = fakeHost(
      "linux",
      [
        "/bin/sh",
        "/usr/bin/sh",
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/rbash",
        "/usr/bin/tmux",
        "/usr/bin/zsh",
      ],
      { PATH: "/usr/bin:/bin" },
      {
        etcShells:
          "# /etc/shells: valid login shells\n/bin/sh\n/usr/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/rbash\n/usr/bin/tmux\n/usr/bin/zsh\n/usr/bin/fish\n",
        realpaths: {
          "/bin/sh": "/usr/bin/dash",
          "/usr/bin/sh": "/usr/bin/dash",
          "/bin/bash": "/usr/bin/bash",
        },
      },
    );
    expect(detectShells(host).map((s) => s.path)).toEqual(["/bin/sh", "/bin/bash", "/usr/bin/zsh"]);
  });

  test("finds fish and Nushell outside PATH (a GUI app's PATH misses Homebrew)", () => {
    const host = fakeHost(
      "darwin",
      ["/bin/zsh", "/opt/homebrew/bin/fish", "/home/me/.cargo/bin/nu"],
      { PATH: "/usr/bin:/bin" },
      { etcShells: "/bin/zsh\n" },
    );
    expect(detectShells(host).map((s) => [s.id, s.name])).toEqual([
      ["/bin/zsh", "zsh"],
      ["/opt/homebrew/bin/fish", "fish"],
      ["/home/me/.cargo/bin/nu", "Nushell"],
    ]);
  });
});

describe("systemDefaultShell", () => {
  test("Windows: PowerShell on PATH, else ComSpec", () => {
    expect(systemDefaultShell(fakeHost("win32", [POWERSHELL], WIN_ENV)).path).toBe(POWERSHELL);
    const noPowerShell = fakeHost("win32", [], WIN_ENV);
    expect(systemDefaultShell(noPowerShell)).toMatchObject({
      id: "cmd",
      path: "C:\\Windows\\system32\\cmd.exe",
    });
  });

  test("macOS and Linux: $SHELL, else the first of bash, zsh, sh", () => {
    expect(systemDefaultShell(fakeHost("darwin", [], { SHELL: "/bin/zsh" }))).toMatchObject({
      name: "zsh",
      path: "/bin/zsh",
    });
    expect(systemDefaultShell(fakeHost("linux", ["/bin/zsh", "/bin/sh"])).path).toBe("/bin/zsh");
  });
});

describe("resolveShellChoice", () => {
  const host = fakeHost(
    "win32",
    [
      POWERSHELL,
      "C:\\Program Files\\Git\\cmd\\git.exe",
      GIT_BASH,
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\tools\\nu.exe",
    ],
    { ...WIN_ENV, Path: `${WIN_ENV.Path};C:\\tools` },
  );

  test("a detected shell resolves to its path and arguments", () => {
    expect(resolveShellChoice(host, { kind: "detected", id: "git-bash" })).toEqual({
      shell: { id: "git-bash", name: "Git Bash", path: GIT_BASH, args: ["--login", "-i"] },
    });
  });

  test("a detected shell that's gone reports its name", () => {
    expect(resolveShellChoice(host, { kind: "detected", id: "pwsh" })).toEqual({
      missing: "PowerShell",
    });
    const linux = fakeHost("linux", [], {}, { etcShells: "" });
    expect(resolveShellChoice(linux, { kind: "detected", id: "/usr/bin/fish" })).toEqual({
      missing: "fish",
    });
  });

  test("a custom shell is found by path or by name on PATH, with its arguments", () => {
    expect(resolveShellChoice(host, { kind: "custom", path: "nu", args: ["-l"] })).toEqual({
      shell: { id: "custom", name: "nu.exe", path: "C:\\tools\\nu.exe", args: ["-l"] },
    });
    expect(resolveShellChoice(host, { kind: "custom", path: "C:\\tools\\nu.exe" })).toMatchObject({
      shell: { path: "C:\\tools\\nu.exe", args: [] },
    });
    expect(resolveShellChoice(host, { kind: "custom", path: "D:\\gone\\x.exe" })).toEqual({
      missing: "D:\\gone\\x.exe",
    });
  });

  test("a relative path with a directory isn't looked up on PATH", () => {
    expect(findShellProgram(host, "tools\\nu.exe")).toBeNull();
    expect(findShellProgram(host, "  ")).toBeNull();
  });
});
