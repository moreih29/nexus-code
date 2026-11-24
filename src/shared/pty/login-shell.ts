const LOGIN_SHELL_NAMES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "powershell",
  "pwsh",
  "cmd",
  "wsl",
]);

export function isLoginShell(comm: string): boolean {
  return LOGIN_SHELL_NAMES.has(comm.trim().replace(/^-/, "").toLowerCase());
}
