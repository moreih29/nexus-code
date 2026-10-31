/**
 * Login-shell program names, to tell whether a terminal's foreground process
 * is its shell (nothing is running) or a program.
 *
 * `ps -o comm=` may prefix a login shell with "-" (e.g. "-zsh"); it is stripped.
 * On Windows the agent names a program by its file name without ".exe",
 * in the file's case.
 */
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
]);

/** True when `comm` (a `ps -o comm=` basename) names a login shell. */
export function isLoginShell(comm: string): boolean {
  return LOGIN_SHELL_NAMES.has(comm.trim().replace(/^-/, "").toLowerCase());
}
